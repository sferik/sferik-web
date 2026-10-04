// Tests for server.js: content negotiation, every resource in every format,
// static files, errors, and the live-data cache. Run with `bun run test:server`.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import { createApp, negotiate, nodeFiles, wrap, stripTags, tex, pdfResume, latexResume, type AppOptions } from "../src/server.ts";
import type { Resume } from "../src/types.js";

const ROOT = path.join(import.meta.dirname, "..");

interface Got {
  status: number;
  type: string;
  headers: Headers;
  body: string;
  bytes: Buffer;
}
type App = { get: (url: string, opts?: { accept?: string; method?: string }) => Promise<Got>; close: () => Promise<void> };

// Start an app on a random port; returns a request helper.
async function serve(options: AppOptions): Promise<App> {
  const server = http.createServer(createApp(options));
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const get: App["get"] = async (url, { accept, method = "GET" } = {}) => {
    const res = await fetch(base + url, { method, headers: accept ? { accept } : {} });
    const bytes = Buffer.from(await res.arrayBuffer());
    return { status: res.status, type: res.headers.get("content-type") ?? "", headers: res.headers, body: bytes.toString(), bytes };
  };
  return {
    get,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const JSON_ = "application/json";
const HTML = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"; // what browsers send

// A fake network: responds with fixtures and records requests.
type Fixture = unknown[] | object | number | Error | ((init: RequestInit) => Promise<Response>);
function fakeNet(overrides: Record<string, Fixture> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fixtures: Record<string, Fixture> = {
    "https://rubygems.org/api/v1/owners/sferik/gems.json": [
      { name: "multi_json", downloads: 2_000_000_000 },
      { name: "multi_xml", downloads: 1_000_000_000 },
      { name: "twitter", downloads: 30_000_000 },
    ],
    "https://github-contributions-api.jogruber.de/v4/sferik?y=last": {
      contributions: [
        { date: "2025-10-01", count: 0, level: 0 }, // a Wednesday: the graph pads Sun–Tue
        { date: "2025-10-02", count: 3, level: 2 },
        { date: "2025-10-03", count: 5, level: 4 },
      ],
    },
    "https://api.github.com/users/sferik/events/public?per_page=30": [
      { type: "WatchEvent", repo: { name: "a/b" } },
      { type: "PushEvent", repo: { name: "sferik/x-ruby" }, payload: { head: "abc1234def5678" }, created_at: "2026-10-01T12:00:00Z" },
    ],
    ...overrides,
  };
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("https://api.github.com/repos/")) return Response.json({ stargazers_count: 1234 });
    const body = fixtures[url];
    if (body instanceof Error) throw body;
    if (typeof body === "number") return new Response("", { status: body });
    if (typeof body === "function") return body(init);
    return Response.json(body);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

// ------------------------------------------------------------ negotiation

describe("negotiate", () => {
  test("browsers get html, API clients json, curl text", () => {
    assert.equal(negotiate(HTML), "html");
    assert.equal(negotiate("application/json"), "json");
    assert.equal(negotiate("application/*"), "json");
    assert.equal(negotiate("*/*"), "text");
    assert.equal(negotiate(undefined), "text");
    assert.equal(negotiate("text/plain"), "text");
    assert.equal(negotiate("text/*"), "html");
    assert.equal(negotiate("application/xhtml+xml"), "html");
  });

  test("q-values decide, and nothing acceptable is null", () => {
    assert.equal(negotiate("text/html;q=0.5, application/json"), "json");
    assert.equal(negotiate("application/json;q=0.2, text/plain;q=0.9"), "text");
    assert.equal(negotiate("image/png"), null);
    assert.equal(negotiate("text/html;q=0"), null);
  });

  test("stripTags removes markup and decodes entities", () => {
    assert.equal(stripTags('<a href="x">R&amp;D &lt;3 &quot;q&quot; &#39;s&#39;</a> &gt;'), `R&D <3 "q" 's' >`);
  });

  test("wrap keeps paragraphs and indents", () => {
    assert.deepEqual(wrap("aaa bbb ccc\n\nddd", 8, "  "), ["  aaa", "  bbb", "  ccc", "", "  ddd"]);
  });
});

// -------------------------------------------------------------- offline

describe("offline (snapshots from data/)", () => {
  let app: App;
  before(async () => {
    app = await serve({ offline: true });
  });
  after(() => app.close());

  test("/ in all three formats", async () => {
    const html = await app.get("/", { accept: HTML });
    assert.equal(html.status, 200);
    assert.match(html.type, /^text\/html/);
    assert.match(html.body, /data-page="home"/);
    assert.equal(html.headers.get("vary"), "Accept");

    const json = JSON.parse((await app.get("/", { accept: JSON_ })).body);
    assert.equal(json.profile.name, "Erik Berlin");
    assert.deepEqual(
      json.modules.map((m: { url: string }) => m.url),
      ["/whoami", "/contributions", "/src", "/name", "/talks", "/finger"],
    );

    const text = await app.get("/");
    assert.match(text.type, /^text\/plain/);
    assert.match(text.body, /^╭─+╮\n│ Erik Berlin +│/);
    assert.match(text.body, /sferik@mbp ~> whoami\nI've spent nearly two decades/);
    assert.match(text.body, /sferik@mbp ~> ls -t ~\/talks \| head -6\nNov 2015 {2}The Value of Being Lazy/);
    assert.equal(text.headers.get("access-control-allow-origin"), "*");
    for (const line of text.body.split("\n")) assert.ok(line.length <= 80, line);
  });

  test("every module as JSON and text", async () => {
    const whoami = JSON.parse((await app.get("/whoami", { accept: JSON_ })).body);
    assert.equal(whoami.multiDownloads, 1_776_183_113);
    assert.match(whoami.blocks[1].html, /1,776,183,113 combined downloads/);
    assert.equal(whoami.blocks.find((b: { type: string }) => b.type === "figure").href, "https://xkcd.com/2347/");
    assert.match((await app.get("/whoami")).body, /\[A tall, precarious tower/);

    const graph = JSON.parse((await app.get("/contributions", { accept: JSON_ })).body);
    assert.equal(graph.live, false);
    assert.equal(graph.lastPush, null);
    assert.ok(graph.total > 0 && graph.longestStreak > 0);
    assert.match((await app.get("/contributions")).body, /^ {4} *\w{3}.*\n {4}[·░▒▓█ ]+\nMon /);
    assert.match((await app.get("/contributions")).body, /On GitHub since 2008\.$/m);

    const src = JSON.parse((await app.get("/src", { accept: JSON_ })).body);
    assert.equal(src.live, false);
    assert.equal(src.total.downloads, 5_460_234_129);
    assert.equal(src.projects[0].name, "multi_json");
    assert.equal(src.projects.at(-1).name, "rubygems.org");
    assert.equal(src.projects.find((p: { name: string }) => p.name === "tesla").stars, 1);
    const srcText = (await app.get("/src")).body;
    assert.match(srcText, /^multi_json +One interface to every Ruby JSON library\. +1\.2B↓ +27★$/m);
    assert.match(srcText, /^openai .* 2\.3M↓/m);
    assert.match(srcText, /^tesla .* 6\.0k↓ +1★$/m);
    assert.match(srcText, /^rubygems\.org +The Ruby package registry\. +2\.4k★$/m);
    assert.match(srcText, /^total +5\.5B↓ +\d+\.\dk★$/m);

    assert.equal(JSON.parse((await app.get("/name", { accept: JSON_ })).body).commit, "8c0d698");
    assert.match((await app.get("/name")).body, /^8c0d698 Rename Erik Michaels-Ober to Erik Berlin \(2017\)\nWhen Diana/);

    assert.equal(JSON.parse((await app.get("/talks", { accept: JSON_ })).body).talks.length, 18);
    const talks = (await app.get("/talks")).body;
    assert.match(talks, /^Mar 2011 {2}GUI Programming with MacRuby$/m);
    assert.match(talks, /\nPodcasts:\nFeb 2016 {2}The Crystal Programming Language \(Ruby Rogues, episode 248\)\n {10}topenddevs\.com/);
    // Lines fit in 80 columns, except a URL too long to fit anywhere (it can't be broken).
    for (const line of talks.split("\n")) assert.ok(line.length <= 80 || /^ +(\w+: +)?\S{60,}$/.test(line), line);
    assert.match(talks, /video: {2}youtube\.com\/watch/);

    const finger = JSON.parse((await app.get("/finger", { accept: JSON_ })).body);
    assert.equal(finger.mail, "sferik@gmail.com");
    assert.match((await app.get("/finger")).body, /^Login: sferik +Name: Erik Berlin\nDirectory: \/Users\/sferik +Shell: \/opt\/homebrew\/bin\/fish/);
  });

  test("the resume as JSON Resume, as a man page, and as the page", async () => {
    const r = JSON.parse((await app.get("/resume", { accept: JSON_ })).body);
    assert.equal(r.basics.name, "Erik Berlin");
    assert.equal(r.work[0].name, "One Thing Incorporated");
    const man = (await app.get("/resume")).body;
    assert.match(man, /^SFERIK\(1\) +General Commands Manual +SFERIK\(1\)\n\nNAME\n {7}sferik, Erik Berlin – software engineer/);
    assert.match(man, /\n {7}2011 {7}Fellow, Code for America\n/);
    assert.match(man, /\n {7}2023– {6}Founder, One Thing Incorporated\n/);
    assert.match(man, /\n {18}- Joined through the acquisition/);
    assert.match(man, /more than\s+5 billion\s+combined/);
    assert.match(man, /2013 {7}Coach and mentor: Rails Girls Summer of Code/);
    assert.match(man, /\nPATENTS\n {7}2011 {7}Method and system for creating user based summaries for\n {18}content distribution, US20110153423A1\.\n/);
    for (const line of man.split("\n")) assert.ok(line.length <= 80, line);
    assert.match((await app.get("/resume", { accept: HTML })).body, /data-page="resume"/);
    assert.match((await app.get("/talks", { accept: HTML })).body, /data-page="talks"/);
    assert.match((await app.get("/whoami", { accept: HTML })).body, /data-page="home"/);
  });

  test(".json and .txt suffixes, /index, and trailing slashes", async () => {
    assert.match((await app.get("/resume.json")).type, /^application\/json/);
    assert.match((await app.get("/resume.txt", { accept: JSON_ })).body, /^SFERIK\(1\)/);
    assert.equal(JSON.parse((await app.get("/.json")).body).profile.handle, "sferik");
    assert.match((await app.get("/index", { accept: JSON_ })).body, /"profile"/);
    assert.match((await app.get("/resume/", { accept: JSON_ })).body, /"basics"/);
  });

  test("406 when nothing acceptable", async () => {
    const res = await app.get("/resume", { accept: "image/png" });
    assert.equal(res.status, 406);
    assert.match(res.body, /Try text\/html, application\/json, text\/plain/);
    assert.match((await app.get("/whoami", { accept: "image/png" })).body, /Try text\/html, application\/json, or text\/plain\./);
  });

  test("public static files, and nothing else", async () => {
    const css = await app.get("/site.css");
    assert.match(css.type, /^text\/css/);
    assert.ok(css.headers.get("last-modified"));
    assert.match((await app.get("/.plan")).type, /^text\/plain/);
    assert.match((await app.get("/img/dependency.png")).type, /^image\/png/);
    assert.match((await app.get("/share/standard.flf")).body, /^flf2a/);
    assert.match((await app.get("/robots.txt")).body, /User-agent/);
    for (const hidden of [
      "/server.js",
      "/playwright.config.js",
      "/data/profile.json",
      "/package.json",
      "/tests/server.test.js",
      "/../etc/passwd",
      "/nope.css",
    ]) {
      assert.equal((await app.get(hidden)).status, 404, hidden);
    }
  });

  test("404 in each format", async () => {
    const json = await app.get("/nope", { accept: JSON_ });
    assert.equal(json.status, 404);
    assert.deepEqual(JSON.parse(json.body), { error: "Not Found", path: "/nope" });
    const html = await app.get("/nope", { accept: HTML });
    assert.match(html.body, /no such file|does not exist/);
    assert.equal((await app.get("/nope")).body, "cd: The directory '/nope' does not exist\n");
    assert.equal((await app.get("/nope", { accept: "image/png" })).status, 404);
  });

  test("HEAD, OPTIONS, and other methods", async () => {
    const head = await app.get("/resume", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    const options = await app.get("/resume", { method: "OPTIONS" });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("access-control-allow-origin"), "*");
    const post = await app.get("/resume", { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD, OPTIONS");
  });
});

// ------------------------------------------------------------ live data

describe("live data", () => {
  test("uses RubyGems and GitHub, with a token when given", async () => {
    const net = fakeNet();
    const app = await serve({ fetch: net.fetch, token: "secret" });
    const src = JSON.parse((await app.get("/src", { accept: JSON_ })).body);
    assert.equal(src.live, true);
    assert.equal(src.total.downloads, 3_030_000_000);
    assert.equal(src.total.gems, 3);
    assert.equal(src.projects[0].downloads, 2_000_000_000);
    assert.equal(src.projects.find((p: { name: string }) => p.name === "simplecov").downloads, 505164512); // not in the live list: snapshot
    assert.equal(src.projects.find((p: { name: string }) => p.name === "rubygems.org").stars, 1234);
    const github = net.calls.find((c) => c.url.includes("api.github.com"))!;
    assert.equal((github.init.headers as Record<string, string>).authorization, "Bearer secret");

    const whoami = JSON.parse((await app.get("/whoami", { accept: JSON_ })).body);
    assert.equal(whoami.multiDownloads, 3_000_000_000);

    const graph = JSON.parse((await app.get("/contributions", { accept: JSON_ })).body);
    assert.equal(graph.live, true);
    assert.equal(graph.total, 8);
    assert.equal(graph.longestStreak, 2);
    assert.deepEqual(graph.lastPush, { repo: "sferik/x-ruby", sha: "abc1234def5678", at: "2026-10-01T12:00:00Z" });
    const text = (await app.get("/contributions")).body;
    assert.match(text, /^Wed ·$/m);
    assert.match(text, /^Fri █$/m);
    assert.match(text, /On GitHub since 2008 through 2026-10-01 \(sferik\/x-ruby@abc1234\)\./);
    await app.close();
  });

  test("falls back to snapshots when services fail or time out", async () => {
    const hang = (init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("timeout"))));
    const net = fakeNet({
      "https://rubygems.org/api/v1/owners/sferik/gems.json": 503,
      "https://github-contributions-api.jogruber.de/v4/sferik?y=last": new Error("down"),
      "https://api.github.com/users/sferik/events/public?per_page=30": hang,
    });
    const app = await serve({ fetch: net.fetch, timeout: 20 });
    const src = JSON.parse((await app.get("/src", { accept: JSON_ })).body);
    assert.equal(src.total.downloads, 5_460_234_129);
    const graph = JSON.parse((await app.get("/contributions", { accept: JSON_ })).body);
    assert.equal(graph.live, false);
    assert.equal(graph.lastPush, null);
    // Asking again before the next refresh is due also gets the snapshot.
    const again = await app.get("/contributions", { accept: JSON_ });
    assert.equal(again.status, 200);
    assert.equal(JSON.parse(again.body).live, false);
    await app.close();
  });

  test("with a store, requests only read it, and a refresh loads and saves, keeping the old value when a load fails", async () => {
    const saved = new Map<string, unknown>([["gems", { multi_json: 1, multi_xml: 0 }]]);
    const store = { get: async (key: string) => saved.get(key), put: async (key: string, value: unknown) => void saved.set(key, value) };
    const net = fakeNet({
      "https://rubygems.org/api/v1/owners/sferik/gems.json": [
        { name: "multi_json", downloads: 2 },
        { name: "multi_xml", downloads: 0 },
      ],
    });

    const reader = await serve({ fetch: net.fetch, store });
    assert.equal(JSON.parse((await reader.get("/whoami", { accept: JSON_ })).body).multiDownloads, 1);
    assert.equal(net.calls.length, 0); // never fetched during a request
    await reader.close();

    const refresher = await serve({ fetch: net.fetch, store, refresh: true });
    await refresher.get("/whoami", { accept: JSON_ });
    assert.deepEqual(saved.get("gems"), { multi_json: 2, multi_xml: 0 });
    await refresher.close();

    const failing = await serve({ fetch: fakeNet({ "https://rubygems.org/api/v1/owners/sferik/gems.json": 503 }).fetch, store, refresh: true });
    assert.equal(JSON.parse((await failing.get("/whoami", { accept: JSON_ })).body).multiDownloads, 2);
    assert.deepEqual(saved.get("gems"), { multi_json: 2, multi_xml: 0 });
    await failing.close();
  });

  test("projects are sorted by downloads, with related ones listed together", async () => {
    const app = await serve({ offline: true });
    const names = (JSON.parse((await app.get("/src", { accept: JSON_ })).body) as { projects: { name: string }[] }).projects.map((p) => p.name);
    assert.deepEqual(names.slice(0, 3), ["multi_json", "multi_xml", "simplecov"]);
    assert.equal(names.indexOf("nba"), names.indexOf("mlb") + 1);
    assert.equal(names.indexOf("minitest-memory"), names.indexOf("minitest-strict") + 1);
    assert.deepEqual(names.slice(names.indexOf("twitter"), names.indexOf("twitter") + 3), ["twitter", "x", "x-cli"]);
    assert.deepEqual(names.slice(names.indexOf("oauth2"), names.indexOf("oauth2") + 3), ["oauth2", "simple_oauth", "omniauth"]);
    await app.close();
  });

  test("a gem without a repository has no stars, in the JSON, the text, or the total", async (t) => {
    const files = nodeFiles(path.join(import.meta.dirname, ".."));
    const lone = {
      name: "lone",
      url: "https://example.com/lone",
      description: "A gem without a repository.",
      gem: "lone",
      repo: null,
      downloads: 5000,
      stars: null,
    };
    const app = await serve({
      offline: true,
      files: {
        ...files,
        data: async (name) => {
          const data = (await files.data(name)) as { projects: unknown[] };
          return name === "projects" ? { ...data, projects: [...data.projects, lone] } : data;
        },
      },
    });
    t.after(() => app.close());
    const src = JSON.parse((await app.get("/src", { accept: JSON_ })).body) as { projects: { name: string; stars: number | null }[] };
    assert.equal(src.projects.find((p) => p.name === "lone")!.stars, null);
    assert.match((await app.get("/src")).body, /^lone +A gem without a repository\. +5\.0k↓$/m);
  });

  test("projects that aren't gems come after the gems, most starred first", async () => {
    const files = nodeFiles(path.join(import.meta.dirname, ".."));
    const extra = (name: string, stars: number) => ({
      name,
      url: `https://example.com/${name}`,
      description: name,
      gem: null,
      repo: null,
      downloads: null,
      stars,
    });
    const app = await serve({
      offline: true,
      files: {
        ...files,
        data: async (name) => {
          const data = (await files.data(name)) as { projects: unknown[] };
          return name === "projects" ? { ...data, projects: [...data.projects, extra("few", 1), extra("many", 99_999)] } : data;
        },
      },
    });
    const names = (JSON.parse((await app.get("/src", { accept: JSON_ })).body) as { projects: { name: string }[] }).projects.map((p) => p.name);
    assert.deepEqual(names.slice(-3), ["many", "rubygems.org", "few"]);
    await app.close();
  });

  test("a failing request answers 500 and the server keeps running", async (t) => {
    const errors = t.mock.method(console, "error", () => {});
    const app = await serve({ offline: true, files: nodeFiles(fs.mkdtempSync(path.join(os.tmpdir(), "sferik-"))) }); // no data/
    const res = await app.get("/whoami", { accept: JSON_ });
    assert.equal(res.status, 500);
    assert.equal(res.body, "Internal Server Error\n");
    assert.equal(errors.mock.callCount(), 1);
    assert.equal((await app.get("/whoami", { accept: JSON_ })).status, 500);
    await app.close();
  });

  test("no recent push means no lastPush", async () => {
    const net = fakeNet({ "https://api.github.com/users/sferik/events/public?per_page=30": [{ type: "WatchEvent", repo: { name: "a/b" } }] });
    const app = await serve({ fetch: net.fetch });
    assert.equal(JSON.parse((await app.get("/contributions", { accept: JSON_ })).body).lastPush, null);
    await app.close();
  });

  test("caches, serves stale while refreshing, and keeps old values when a refresh fails", async () => {
    let clock = 0;
    let gems: { name: string; downloads: number }[] | Error = [{ name: "multi_json", downloads: 1 }];
    const net = fakeNet({ "https://rubygems.org/api/v1/owners/sferik/gems.json": () => (gems instanceof Error ? Promise.reject(gems) : Response.json(gems)) });
    const app = await serve({ fetch: net.fetch, now: () => clock });
    const total = async () => JSON.parse((await app.get("/src", { accept: JSON_ })).body).total.downloads;
    const rubygemsCalls = () => net.calls.filter((c) => c.url.startsWith("https://rubygems.org/")).length;

    assert.equal(await total(), 1);
    assert.equal(await total(), 1);
    assert.equal(rubygemsCalls(), 1); // cached

    gems = [{ name: "multi_json", downloads: 2 }];
    clock += 3600e3;
    assert.equal(await total(), 1); // stale, while it refreshes in the background
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await total(), 2);
    assert.equal(rubygemsCalls(), 2);

    gems = new Error("down");
    clock += 3600e3;
    await total();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await total(), 2); // the failed refresh kept the old value
    await app.close();
  });
});

// ------------------------------------------------------------ OpenAPI

// Just enough JSON Schema to check the API's responses against its spec:
// returns a list of mismatches, empty when the value fits.
type Schema = { [key: string]: unknown };
function validate(spec: Schema, schema: Schema, value: unknown, at = "$"): string[] {
  if (typeof schema.$ref === "string") {
    const target = schema.$ref
      .slice(2)
      .split("/")
      .reduce((node: Schema, key) => node[key] as Schema, spec);
    return validate(spec, target, value, at);
  }
  if (schema.oneOf) {
    const fits = (schema.oneOf as Schema[]).filter((s) => !validate(spec, s, value, at).length).length;
    return fits === 1 ? [] : [`${at}: matches ${fits} of oneOf`];
  }
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  const types = [schema.type ?? []].flat() as string[];
  if (types.length && !types.includes(kind) && !(kind === "integer" && types.includes("number"))) return [`${at}: ${kind}, not ${types.join(" or ")}`];
  if ("const" in schema && value !== schema.const) return [`${at}: not ${JSON.stringify(schema.const)}`];
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) return [`${at}: ${JSON.stringify(value)} isn't one of the enum`];
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern as string).test(value)) return [`${at}: doesn't match ${schema.pattern}`];
  if (typeof value === "number" && ((schema.minimum as number) > value || (schema.maximum as number) < value)) return [`${at}: out of range`];
  if (Array.isArray(value)) return value.flatMap((v, i) => validate(spec, schema.items as Schema, v, `${at}[${i}]`));
  if (kind !== "object") return [];
  const props = (schema.properties ?? {}) as Record<string, Schema>;
  const obj = value as Record<string, unknown>;
  return [
    ...((schema.required ?? []) as string[]).filter((k) => !(k in obj)).map((k) => `${at}.${k}: missing`),
    ...Object.keys(obj).flatMap((k) =>
      k in props ? validate(spec, props[k], obj[k], `${at}.${k}`) : schema.additionalProperties === false ? [`${at}.${k}: not in the spec`] : [],
    ),
  ];
}

describe("the OpenAPI spec", () => {
  const spec = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "public", "openapi.json"), "utf8")) as Schema;
  const paths = spec.paths as Record<string, { get: { responses: { "200": { content: Record<string, { schema: Schema }> } } } }>;

  test("is served at /openapi.json, to any origin", async () => {
    const app = await serve({ offline: true });
    const res = await app.get("/openapi.json");
    assert.equal(res.status, 200);
    assert.match(res.type, /^application\/openapi\+json/);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(JSON.parse(res.body), spec);
    assert.equal((spec as { openapi: string }).openapi, "3.1.0");
    await app.close();
  });

  test("lists every resource the home page and its pages are built from", async () => {
    const app = await serve({ offline: true });
    const home = JSON.parse((await app.get("/", { accept: JSON_ })).body) as { modules: { url: string }[]; pages: Record<string, string> };
    for (const url of ["/", "/resume", ...home.modules.map((m) => m.url), ...Object.values(home.pages)]) assert.ok(paths[url], `${url} is in the spec`);
    await app.close();
  });

  // Offline (the snapshots) and live (with a push, so lastPush isn't null).
  for (const [label, options] of [
    ["offline", { offline: true }],
    ["live", { fetch: fakeNet().fetch }],
  ] as const) {
    test(`every path answers in every format it lists, and the JSON fits its schema (${label})`, async (t) => {
      const app = await serve(options);
      t.after(() => app.close());
      for (const [url, item] of Object.entries(paths)) {
        for (const [type, { schema }] of Object.entries(item.get.responses["200"].content)) {
          const res = await app.get(url, { accept: type });
          assert.equal(res.status, 200, `${url} as ${type}`);
          assert.equal(res.type.split(";")[0], type, `${url} as ${type}`);
          if (type === JSON_) assert.deepEqual(validate(spec, schema, JSON.parse(res.body)), [], `${url} as JSON`);
        }
      }
    });
  }

  test("the validator catches what doesn't fit", () => {
    const s = (schema: Schema, value: unknown) => validate(spec, schema, value);
    assert.deepEqual(s({ type: "string" }, 1), ["$: integer, not string"]);
    assert.deepEqual(s({ type: "number" }, 1), []);
    assert.deepEqual(s({ const: "p" }, "q"), ['$: not "p"']);
    assert.deepEqual(s({ enum: ["a"] }, "b"), ['$: "b" isn\'t one of the enum']);
    assert.deepEqual(s({ type: "string", pattern: "^a$" }, "b"), ["$: doesn't match ^a$"]);
    assert.deepEqual(s({ type: "integer", minimum: 0, maximum: 4 }, 5), ["$: out of range"]);
    assert.deepEqual(s({ oneOf: [{ type: "string" }, { type: "string" }] }, "x"), ["$: matches 2 of oneOf"]);
    assert.deepEqual(s({ type: "object", required: ["a"], properties: {}, additionalProperties: false }, { b: 1 }), ["$.a: missing", "$.b: not in the spec"]);
    assert.deepEqual(s({ type: "object" }, { b: 1 }), []);
    assert.deepEqual(s({ $ref: "#/components/schemas/Day" }, { date: "2026-10-02", count: 1, level: 9 }), ["$.level: out of range"]);
  });
});

// ---------------------------------------------------------- the binary

test("node src/server.ts starts, serves, and shuts down on SIGTERM", async () => {
  const child = spawn(process.execPath, [path.join(ROOT, "src/server.ts")], { env: { ...process.env, PORT: "0", SFERIK_OFFLINE: "1" } });
  const url = await new Promise<string>((resolve) => child.stdout.on("data", (d) => resolve(String(d).match(/http:\/\/\S+/)![0])));
  const res = await fetch(url + "/name", { headers: { accept: JSON_ } });
  assert.equal((await res.json()).commit, "8c0d698");
  child.kill("SIGTERM");
  assert.equal(await new Promise((r) => child.on("exit", r)), 0);
});

// ------------------------------------------------------ LaTeX and PDF

const RESUME: Resume = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "resume.json"), "utf8"));

// Check a PDF's structure: header, trailer, and that every xref offset points at its object.
function checkPDF(pdf: Buffer) {
  const text = pdf.toString("latin1");
  assert.match(text, /^%PDF-1\.4\n/);
  assert.match(text, /%%EOF\n$/);
  const startxref = Number(text.match(/startxref\n(\d+)\n%%EOF\n$/)![1]);
  assert.equal(text.slice(startxref, startxref + 4), "xref");
  const [, count] = text.slice(startxref).match(/^xref\n0 (\d+)\n/)!;
  const offsets = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offsets.length, Number(count) - 1);
  offsets.forEach((o, i) => assert.ok(text.startsWith(`${i + 1} 0 obj\n`, o), `object ${i + 1} at ${o}`));
  for (const m of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index + m[0].length;
    assert.equal(text.slice(start + Number(m[1]), start + Number(m[1]) + 10), "\nendstream");
  }
  return text;
}

describe("the resume as LaTeX and PDF", () => {
  let app: App;
  before(async () => {
    app = await serve({ offline: true, now: () => new Date(2027, 0, 15).getTime() });
  });
  after(() => app.close());

  test("negotiation offers them only where they exist", async () => {
    const all = ["html", "json", "text", "latex", "pdf"] as const;
    assert.equal(negotiate("application/pdf"), null);
    assert.equal(negotiate("application/pdf", [...all]), "pdf");
    assert.equal(negotiate("application/x-latex", [...all]), "latex");
    assert.equal(negotiate("application/x-tex", [...all]), "latex");
    assert.equal(negotiate("text/x-tex", [...all]), "latex");
    assert.equal(negotiate("application/*", [...all]), "json");

    const pdf = await app.get("/resume", { accept: "application/pdf" });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.type, "application/pdf");
    assert.equal(pdf.headers.get("content-disposition"), 'inline; filename="erik-berlin-resume.pdf"');
    const latex = await app.get("/resume", { accept: "application/x-latex" });
    assert.match(latex.type, /^application\/x-latex/);
    assert.equal(latex.headers.get("content-disposition"), 'inline; filename="erik-berlin-resume.tex"');

    assert.equal((await app.get("/resume.pdf")).type, "application/pdf");
    assert.match((await app.get("/resume.tex")).body, /^% Erik Berlin's resume/);
    assert.equal((await app.get("/resume.pdf", { method: "HEAD" })).body, "");
    assert.equal((await app.get("/whoami", { accept: "application/pdf" })).status, 406);
    assert.equal((await app.get("/whoami.pdf")).status, 404);
    assert.match(
      (await app.get("/resume", { accept: "image/png" })).body,
      /Try text\/html, application\/json, text\/plain, application\/x-latex, or application\/pdf\./,
    );
  });

  test("the PDF is well formed: two Letter pages of Courier, bold headings, links", async () => {
    const text = checkPDF((await app.get("/resume.pdf")).bytes);
    assert.match(text, /\/Type \/Pages \/Kids \[[^\]]+\] \/Count 2 >>/);
    assert.match(text, /\/MediaBox \[0 0 612 792\]/);
    assert.match(text, /\/BaseFont \/Courier \/Encoding \/WinAnsiEncoding/);
    assert.match(text, /\/F2 9 Tf [^\n]* \(EXPERIENCE\) Tj/);
    assert.match(text, /\/F1 9 Tf [^\n]*Erik Berlin \x96 software engineer/); // the en dash, in WinAnsi
    assert.match(text, /\/URI \(mailto:sferik@gmail\.com\)/);
    assert.match(text, /\/URI \(https:\/\/github\.com\/sferik\)/);
    assert.match(text, /\/URI \(https:\/\/patents\.google\.com\/patent\/US20110153414A1\)/);
    assert.match(text, /\/Title \(Erik Berlin, r\xe9sum\xe9\)/);
    assert.match(text, /\(sferik\.com {20,}January 2027 {20,}2 of 2\) Tj/); // the current month
    assert.match((await app.get("/resume.txt")).body, /\nsferik\.com {20,}January 2027 {20,}SFERIK\(1\)\n$/);
  });

  test("the PDF escapes PDF syntax, falls back for unencodable characters, and keeps headings with their text", () => {
    const odd: Resume = structuredClone(RESUME);
    odd.basics.summary = "Parens (like these), a back\\slash, and an arrow → here. See https://example.com/x.";
    // Enough lines to force headings near page breaks.
    odd.projects = Array.from({ length: 80 }, (_, i) => ({ name: `project-${i}`, description: "x" }));
    const text = checkPDF(pdfResume(odd, new Date()));
    assert.match(text, /\( +Parens \\\(like these\\\), a back\\\\slash, and an arrow \? here\. See\) Tj/);
    assert.match(text, /\/URI \(https:\/\/example\.com\/x\)/); // a full URL, minus the period after it
    const pages = text.split("/Type /Page ").length - 1;
    assert.ok(pages >= 3, `${pages} pages`);
    // No page ends with a heading.
    for (const stream of text.matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
      const body = stream[1].split("\n").slice(1, -1); // without the header and footer
      assert.ok(!/\/F2/.test(body.at(-1) ?? ""), "heading at the bottom of a page");
    }
  });

  test("the LaTeX escapes special characters and formats dates", async () => {
    assert.equal(
      tex("a & b % c $ d # e _ f { g } h ~ i ^ j \\ k – l — m “n” ‘o’"),
      "a \\& b \\% c \\$ d \\# e \\_ f \\{ g \\} h \\textasciitilde{} i \\textasciicircum{} j \\textbackslash{} k -- l --- m ``n'' `o'",
    );
    const doc = (await app.get("/resume.tex")).body;
    assert.match(doc, /^\\documentclass\[10pt,letterpaper\]\{article\}$/m);
    assert.match(doc, /\\begin\{document\}[\s\S]*\\end\{document\}\n$/);
    assert.match(doc, /\\textbf\{Founder, One Thing Incorporated\} \\hfill 2023--present/);
    assert.match(doc, /\\textbf\{Principal Software Engineer, Instacart\} \\hfill 2016\n/);
    assert.match(doc, /delayed\\_job/);
    assert.match(doc, /more than 5 billion combined downloads/);
    assert.match(doc, /\\emph\{Writing Fast Ruby\}/);
    assert.match(doc, /\\href\{mailto:sferik@gmail\.com\}\{sferik@gmail\.com\}/);
    assert.match(doc, /Raised \\\$5\.5 million/);
    assert.match(doc, /\\textbf\{Board of Directors\} \\hfill 2023--2026\\\\\n\\emph\{Pacific Primary\}\n\\par\{\\raggedright President 2025--2026/);
    assert.match(doc, /\\href\{https:\/\/pacificprimary\.org\}\{\\mbox\{pacificprimary\.org\}\}/);
    assert.match(doc, /\\href\{https:\/\/sferik\.com\/talks\}\{\\mbox\{sferik\.com\/talks\}\}/);
    assert.match(doc, /\\textbf\{Coach and mentor\} \\hfill 2013\\\\\n\\emph\{Rails Girls Summer of Code, Ruby Summer of Code, Google Summer of Code\}\n/);
    assert.match(
      doc,
      /\\heading\{Patents\}\n\\begin\{itemize\}\n {2}\\item \\href\{https:\/\/patents\.google\.com\/patent\/US20110153423A1\}\{Method and system for creating user based summaries for content distribution\}, US20110153423A1 \(2011\)\./,
    );
    assert.match(doc, /Known as Erik Michaels-Ober until June 24, 2017/);
    // Braces balance.
    const opens = (doc.replace(/\\[{}]/g, "").match(/\{/g) ?? []).length;
    const closes = (doc.replace(/\\[{}]/g, "").match(/\}/g) ?? []).length;
    assert.equal(opens, closes);
    assert.equal(latexResume(RESUME), doc);
  });
});

// A real TeX engine, when one is installed (brew install tectonic). CI skips this.
const tectonic = spawnSync("tectonic", ["--version"]).status === 0;
test("the LaTeX compiles with tectonic, warning-free, to two pages", { skip: !tectonic && "tectonic isn't installed" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-"));
  fs.writeFileSync(path.join(dir, "resume.tex"), latexResume(RESUME));
  const run = spawnSync("tectonic", ["--keep-logs", "resume.tex"], { cwd: dir, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const log = fs.readFileSync(path.join(dir, "resume.log"), "utf8");
  assert.doesNotMatch(log, /Overfull|Underfull|LaTeX Warning/);
  assert.match(log, /Output written on resume\.xdv \(2 pages/);
  assert.ok(fs.statSync(path.join(dir, "resume.pdf")).size > 10_000);
  fs.rmSync(dir, { recursive: true });
});
