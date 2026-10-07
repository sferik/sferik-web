// Tests for server.js: content negotiation, every resource in every format,
// static files, errors, and the live-data cache. Run with `bun run test:server`.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import ajv from "ajv";
import formats from "ajv-formats";
import fs from "node:fs";
import {
  createApp,
  createHost,
  letter,
  memoryStorage,
  negotiate,
  nodeFiles,
  shade,
  wrap,
  stripTags,
  tex,
  pdfResume,
  latexResume,
  type AppOptions,
  type Letter,
} from "../../src/server.ts";
import type { Resume } from "../../src/types.js";
import { stub } from "../support/stub.ts";

const ROOT = path.join(import.meta.dirname, "..", "..");

interface Got {
  status: number;
  type: string;
  headers: Headers;
  body: string;
  bytes: Buffer;
}
type App = {
  get: (url: string, opts?: { accept?: string; method?: string; headers?: Record<string, string>; body?: string }) => Promise<Got>;
  close: () => Promise<void>;
};

// Start an app on a random port; returns a request helper.
async function serve(options: AppOptions): Promise<App> {
  const server = http.createServer(createApp(options));
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const get: App["get"] = async (url, { accept, method = "GET", headers = {}, body } = {}) => {
    const res = await fetch(base + url, { method, body, headers: { ...headers, ...(accept && { accept }) } });
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
      ["/whoami", "/dependency", "/contributions", "/src", "/name", "/talks", "/finger"],
    );

    const text = await app.get("/");
    assert.match(text.type, /^text\/plain/);
    assert.match(text.body, /^╭─+╮\n│ Erik Berlin +│/);
    assert.match(text.body, /sferik@mbp ~> whoami\nI've spent nearly two decades/);
    assert.match(text.body, /sferik@mbp ~> imgcat ~\/dependency\.webp\n\[A tall, precarious tower/);
    assert.match(text.body, /sferik@mbp ~> ls -t ~\/talks \| head -6\nNov 2015 {2}The Value of Being Lazy/);
    assert.equal(text.headers.get("access-control-allow-origin"), "*");
    for (const line of text.body.split("\n")) assert.ok(line.length <= 80, line);
  });

  test("every module as JSON and text", async () => {
    const whoami = JSON.parse((await app.get("/whoami", { accept: JSON_ })).body);
    assert.equal(whoami.multiDownloads, 1_776_183_113);
    assert.match(whoami.blocks[1].html, /1,776,183,113 combined downloads/);
    assert.ok(whoami.blocks.every((b: { type: string }) => b.type === "p"));
    const dependency = JSON.parse((await app.get("/dependency", { accept: JSON_ })).body);
    assert.equal(dependency.command, "imgcat ~/dependency.webp");
    assert.equal(dependency.figure.href, "https://xkcd.com/2347/");
    assert.match((await app.get("/dependency")).body, /^\[A tall, precarious tower[^]*\]\nhttps:\/\/xkcd\.com\/2347\/ Adapted from xkcd 2347/);

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
    assert.match(srcText, /^tesla +Ruby client for my car\. +6\.0k↓ +1★\nsferik +Ruby client for this website\. +0↓ +1★\nrubygems\.org /m);
    assert.match(srcText, /^octokit +GitHub API Ruby client\. /m);
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

  test("every response has a strict content security policy and the other security headers", async () => {
    for (const url of ["/", "/site.css", "/whoami.json", "/nope"]) {
      const res = await app.get(url, { accept: url === "/" ? "text/html" : undefined });
      const csp = res.headers.get("content-security-policy")!;
      assert.match(csp, /^default-src 'self'; /);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(res.headers.get("strict-transport-security"), "max-age=63072000; includeSubDomains; preload");
      assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
      assert.match(res.headers.get("permissions-policy")!, /camera=\(\), microphone=\(\)/);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    }
  });

  test("public/_headers, for the files Cloudflare serves without the Worker, has the same security headers", async () => {
    const lines = fs.readFileSync(path.join(ROOT, "public", "_headers"), "utf8").split("\n");
    const everything = lines.slice(lines.indexOf("/*") + 1);
    const rules = everything.slice(0, everything.indexOf("")).map((line) => line.trim().split(": "));
    const { headers } = await app.get("/whoami");
    assert.equal(rules.length, 5);
    for (const [name, value] of rules) assert.equal(headers.get(name), value, name);
    // And the same caching as the Node server gives each kind of file: one where
    // every file exists, since the scripts do only once they're built.
    const built = await serve({ offline: true, files: { ...nodeFiles(ROOT), asset: async () => ({ body: Buffer.from("x") }) } });
    for (const [rule, file] of [
      ["/*.js", "/site.js"],
      ["/*.css", "/site.css"],
      ["/*.js.map", "/site.js.map"],
      ["/*.svg", "/icons.svg"],
      ["/*.png", "/og.png"],
      ["/img/*", "/img/dependency.webp"],
      ["/share/*", "/share/standard.flf"],
    ]) {
      const cache = lines[lines.indexOf(rule) + 1].trim();
      assert.equal(cache, `Cache-Control: ${(await built.get(file)).headers.get("cache-control")}`, rule);
    }
    await built.close();
    assert.equal((await app.get("/_headers")).status, 404); // it's not a file to serve
  });

  test("wrangler.jsonc lists every script, style, image, and font for Cloudflare to serve without the Worker", () => {
    const config = fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
    const listed = [...config.matchAll(/"!(\/[^"]+)"/g)].map((m) => m[1]).sort();
    const files = (dir: string, kinds: RegExp) => fs.readdirSync(path.join(ROOT, dir)).filter((name) => kinds.test(name));
    const expected = [
      // What the browser code compiles to, whether or not it has been.
      ...files("src/client", /\.ts$/).flatMap((name) => [`/${name.replace(/\.ts$/, ".js")}`, `/${name.replace(/\.ts$/, ".js.map")}`]),
      ...files("public", /\.(css|svg|png)$/).map((name) => `/${name}`),
      ...files("public/img", /^[^.]/).map((name) => `/img/${name}`),
      ...files("public/share", /^[^.]/).map((name) => `/share/${name}`),
    ].sort();
    assert.deepEqual(listed, expected);
    // None is a pattern: a path that only looks like a file's is the Worker's to answer.
    assert.ok(listed.every((file) => !file.includes("*")));
  });

  test("/resume.json is valid JSON Resume, against the schema it names", async () => {
    // tests/fixtures/resume-schema.json is github.com/jsonresume/resume-schema (MIT) at faeb0ac, the
    // latest schema, which allows sections of your own (like patents and speaking); v1.0.0 doesn't.
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "resume-schema.json"), "utf8"));
    const resume = JSON.parse((await app.get("/resume.json")).body);
    assert.equal(resume.$schema, "https://raw.githubusercontent.com/jsonresume/resume-schema/faeb0ac58e4fb7a1abf3abed3ecd1a5f2e96db9f/schema.json");
    // Both are CommonJS: what they export is the module's default.
    const validator = new ajv.default({ allErrors: true, strict: false });
    formats.default(validator);
    assert.ok(validator.validate(schema, resume), validator.errorsText());
  });

  test("the home page's banner is an h-card, in the HTML itself", async () => {
    const page = (await app.get("/", { accept: "text/html" })).body;
    const card = /<header class="banner h-card" data-profile>[\s\S]*?<\/header>/.exec(page)![0];
    assert.match(card, /<h1 class="p-name sr-only">Erik Berlin<\/h1>/);
    assert.match(card, /<p class="login" data-login aria-hidden="true">&nbsp;<\/p>/);
    // Two commands that have already run: figlet sferik.net, and cat .signature.
    assert.match(
      card,
      /<section class="cmd ran" aria-labelledby="figlet">\n {4}<h2 class="ps1" id="figlet"><span class="prompt" aria-hidden="true">.*<\/span>figlet <span class="arg">sferik\.net<\/span><\/h2>/,
    );
    const art = /<pre class="figlet" aria-hidden="true">([\s\S]*?)<\/pre>/.exec(card)![1].replaceAll("&lt;", "<").split("\n");
    assert.equal(art.length, 5);
    assert.equal(art[0], "       __           _ _                 _");
    assert.equal(art[4], " |___/_|  \\___|_|  |_|_|\\_(_)_| |_|\\___|\\__|");
    assert.ok(art.every((line) => line.length <= 44));
    assert.match(card, /<h2 class="ps1" id="signature">.*cat <span class="arg">\.signature<\/span><\/h2>/);
    assert.match(card, /<div class="out"><p class="p-note">I build libraries and tools software engineers depend on\.<\/p><\/div>/);
    // Where, for the h-card's readers, not the eye.
    assert.match(card, /<data class="p-locality" value="San Francisco"><\/data>\n {2}<data class="p-region" value="California"><\/data>/);
    assert.match(card, /<data class="u-url u-uid" value="https:\/\/sferik\.net\/"><\/data>/);
    assert.match(card, /<data class="p-nickname" value="sferik"><\/data>/);
    assert.match(card, /<data class="u-email" value="mailto:sferik@gmail\.com"><\/data>/);
    // Nothing else in it reads as a property (a class starting p-, u-, dt-, or e-).
    const properties = new Set([...card.matchAll(/class="[^"]*"/g)].flatMap((m) => m[0].slice(7, -1).split(" ")).filter((c) => /^(p|u|dt|e)-/.test(c)));
    assert.deepEqual([...properties].sort(), ["p-locality", "p-name", "p-nickname", "p-note", "p-region", "u-email", "u-uid", "u-url"]);
    // Only the home page has it.
    assert.doesNotMatch((await app.get("/talks", { accept: "text/html" })).body, /h-card/);
  });

  test("each page comes with the JSON it builds itself from, so it needn't ask", async () => {
    const data = async (url: string) => {
      const { body } = await app.get(url, { accept: HTML });
      assert.match(body, /<link rel="modulepreload" href="\/dom\.js" \/>/);
      const json = /<script type="application\/json" id="data">(.*?)<\/script>\n {2}<\/body>/s.exec(body)![1];
      assert.doesNotMatch(json, /</); // nothing in it can end the script
      return JSON.parse(json) as Record<string, unknown>;
    };
    const home = await data("/");
    assert.deepEqual(Object.keys(home), ["/", "/whoami", "/dependency", "/contributions", "/src", "/name", "/talks", "/finger"]);
    // The same as the API's.
    for (const url of Object.keys(home)) assert.deepEqual(home[url], JSON.parse((await app.get(url, { accept: JSON_ })).body), url);
    assert.deepEqual(Object.keys(await data("/talks")), ["/talks"]);
    assert.deepEqual(await data("/resume"), { "/resume": JSON.parse((await app.get("/resume", { accept: JSON_ })).body) });
  });

  test("~/.signature is the motto", async () => {
    const res = await app.get("/.signature");
    assert.match(res.type, /^text\/plain/);
    assert.equal(res.body, "I build libraries and tools software engineers depend on.\n");
  });

  test("responses have ETags, and asking with one gets 304 Not Modified", async () => {
    for (const [url, accept] of [
      ["/site.css", undefined],
      ["/", "text/html"],
      ["/whoami", "application/json"],
      ["/finger", "text/plain"],
    ] as [string, string | undefined][]) {
      const first = await app.get(url, { accept });
      const tag = first.headers.get("etag")!;
      assert.match(tag, /^"[0-9a-f]+-[0-9a-f]+"$/, url);
      const again = await app.get(url, { accept, headers: { "if-none-match": tag } });
      assert.equal(again.status, 304, url);
      assert.equal(again.body, "");
      assert.equal(again.headers.get("etag"), tag);
      // Weakened by a proxy, or one of a list, still matches; another doesn't.
      assert.equal((await app.get(url, { accept, headers: { "if-none-match": `"other", W/${tag}` } })).status, 304);
      assert.equal((await app.get(url, { accept, headers: { "if-none-match": '"other"' } })).status, 200);
    }
    // Different content, different tags; errors have none.
    assert.notEqual((await app.get("/talks", { accept: "text/html" })).headers.get("etag"), (await app.get("/site.css")).headers.get("etag"));
    assert.equal((await app.get("/nope.css")).headers.get("etag"), null);
  });

  test("each page has its own preview card, and its Webmention endpoint", async () => {
    const cards = new Set<string>();
    for (const page of ["/", "/talks", "/resume"]) {
      const html = (await app.get(page, { accept: "text/html" })).body;
      const card = /<meta property="og:image" content="https:\/\/sferik\.net(\/og[\w-]*\.png)" \/>/.exec(html)![1];
      const image = await app.get(card);
      assert.equal(image.status, 200, card);
      assert.match(image.type, /^image\/png/);
      cards.add(card);
      assert.match(html, /<link rel="webmention" href="https:\/\/webmention\.io\/sferik\.net\/webmention" \/>/);
    }
    assert.deepEqual([...cards], ["/og.png", "/og-talks.png", "/og-resume.png"]);
  });

  test("a sitemap of the pages, which robots.txt points to", async () => {
    const sitemap = await app.get("/sitemap.xml");
    assert.match(sitemap.type, /^application\/xml/);
    assert.deepEqual(
      [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]),
      ["https://sferik.net/", "https://sferik.net/talks", "https://sferik.net/resume"],
    );
    assert.match((await app.get("/robots.txt")).body, /^Sitemap: https:\/\/sferik\.net\/sitemap\.xml$/m);
  });

  test("the man page refers to talks(7), finger(1), and sferik(3), but the PDF doesn't", async () => {
    const man = (await app.get("/resume", { accept: "text/plain" })).body;
    assert.match(man, /SEE ALSO\n {7}talks\(7\), finger\(1\), sferik\(3\)\n\n {7}sferik\.net, github\.com\/sferik/);
    assert.doesNotMatch((await app.get("/resume.pdf")).bytes.toString("latin1"), /talks\\\(7\\\)/);
  });

  test("the talks page describes each talk as a schema.org event", async () => {
    const html = (await app.get("/talks", { accept: "text/html" })).body;
    const list = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(html)![1]);
    assert.equal(list["@type"], "ItemList");
    assert.equal(list.itemListElement.length, 18);
    const first = list.itemListElement[0].item;
    assert.equal(first["@type"], "Event");
    assert.equal(first.name, "The Value of Being Lazy, or How I Made OpenStruct 10X Faster");
    assert.equal(first.startDate, "2015-11");
    assert.deepEqual(first.superEvent, { "@type": "Event", name: "Rails Israel" });
    assert.equal(first.location.address, "Tel Aviv");
    assert.equal(first.performer.alternateName, "Erik Michaels-Ober");
    assert.equal(first.recordedIn.url, "https://www.youtube.com/watch?v=6lQeBfSVrpk");
    assert.equal(first.subjectOf.url, "https://speakerdeck.com/sferik/the-value-of-being-lazy");
    // A talk without a video or slides has neither.
    const bare = list.itemListElement.map((e: { item: object }) => e.item).find((t: object) => !("recordedIn" in t) && !("subjectOf" in t));
    assert.ok(bare);
    // Only the talks page has it.
    assert.doesNotMatch((await app.get("/resume", { accept: "text/html" })).body, /"@type":"ItemList"/);
  });

  test("the Node server gzips text for clients that take it", async () => {
    const gz = await serve({ offline: true, compress: true });
    try {
      const page = await gz.get("/", { accept: "text/html", headers: { "accept-encoding": "gzip, br" } });
      assert.equal(page.headers.get("content-encoding"), "gzip");
      assert.equal(page.headers.get("vary"), "Accept, Accept-Encoding");
      assert.match(page.body, /<header class="banner h-card"/); // fetch unzips it
      const tag = page.headers.get("etag")!;
      assert.match(tag, /-gz"$/);
      assert.equal((await gz.get("/", { accept: "text/html", headers: { "accept-encoding": "gzip", "if-none-match": tag } })).status, 304);
      // Not for clients that don't take it, small bodies, or images.
      assert.equal((await gz.get("/site.css", { headers: { "accept-encoding": "identity" } })).headers.get("content-encoding"), null);
      assert.equal((await gz.get("/.plan", { headers: { "accept-encoding": "gzip" } })).headers.get("content-encoding"), null);
      assert.equal((await gz.get("/og.png", { headers: { "accept-encoding": "gzip" } })).headers.get("content-encoding"), null);
      assert.equal((await gz.get("/site.css", { headers: { "accept-encoding": "gzip" } })).headers.get("vary"), "Accept-Encoding");
    } finally {
      await gz.close();
    }
  });

  test("/version says which commit is deployed, and when", async () => {
    const local = JSON.parse((await app.get("/version")).body);
    assert.deepEqual(local, { commit: null, deployed: null, url: null });
    const deployed = await serve({ offline: true, version: { commit: "6cc43d0aa1b2", deployed: "2026-10-05T21:40:00Z" } });
    try {
      assert.deepEqual(JSON.parse((await deployed.get("/version")).body), {
        commit: "6cc43d0aa1b2",
        deployed: "2026-10-05T21:40:00Z",
        url: "https://github.com/sferik/sferik-web/commit/6cc43d0aa1b2",
      });
    } finally {
      await deployed.close();
    }
  });

  test("WebFinger points @sferik@sferik.net to the Mastodon account", async () => {
    const res = await app.get("/.well-known/webfinger?resource=acct:sferik@sferik.net");
    assert.equal(res.status, 200);
    assert.match(res.type, /^application\/jrd\+json/);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const jrd = JSON.parse(res.body);
    assert.equal(jrd.subject, "acct:sferik@mastodon.social");
    assert.equal(jrd.links.find((l: { rel: string }) => l.rel === "self").href, "https://mastodon.social/users/sferik");
    assert.equal((await app.get("/.well-known/webfinger?resource=acct:SFERIK@sferik.com")).status, 200);
    assert.equal((await app.get("/.well-known/webfinger?resource=acct:someone@sferik.net")).status, 404);
    assert.equal((await app.get("/.well-known/webfinger")).status, 400);
  });

  test("the talks as an Atom feed", async () => {
    const res = await app.get("/talks.atom");
    assert.equal(res.status, 200);
    assert.match(res.type, /^application\/atom\+xml/);
    assert.match(res.body, /^<\?xml version="1\.0" encoding="utf-8"\?>\n<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
    const entries = res.body.match(/<entry>/g)!;
    assert.equal(entries.length, 18);
    assert.match(res.body, /<title>The Value of Being Lazy, or How I Made OpenStruct 10X Faster<\/title>\n {4}<updated>2015-11-01T00:00:00Z<\/updated>/);
    assert.match(res.body, /<link rel="alternate" type="text\/html" title="Video" href="https:\/\/www\.youtube\.com\/watch\?v=6lQeBfSVrpk"\/>/);
    assert.match(res.body, /<link rel="related" type="text\/html" title="Slides" href="https:\/\/speakerdeck\.com\/sferik\/the-value-of-being-lazy"\/>/);
    assert.match(res.body, /<summary>Rails Israel, Tel Aviv<\/summary>/);
    // A talk with neither slides nor video links to its year on the talks page.
    assert.match(res.body, /href="https:\/\/sferik\.net\/talks#y\d{4}"\/>/);
  });

  test("public static files, and nothing else", async () => {
    const css = await app.get("/site.css");
    assert.match(css.type, /^text\/css/);
    assert.ok(css.headers.get("last-modified"));
    assert.equal(css.headers.get("cache-control"), "no-cache");
    assert.match((await app.get("/.plan")).type, /^text\/plain/);
    const comic = await app.get("/img/dependency.webp");
    assert.match(comic.type, /^image\/webp/);
    assert.equal(comic.headers.get("cache-control"), "public, max-age=86400, stale-while-revalidate=604800"); // it rarely changes
    assert.equal((await app.get("/robots.txt")).headers.get("cache-control"), "public, max-age=300");
    assert.match((await app.get("/og.png")).type, /^image\/png/);
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
    assert.deepEqual(JSON.parse(json.body), { error: "Not Found", code: "not_found", path: "/nope" });
    const html = await app.get("/nope", { accept: HTML });
    assert.match(html.body, /no such file|does not exist/);
    assert.equal((await app.get("/nope")).body, "cd: The directory '/nope' does not exist\n");
    assert.equal((await app.get("/nope", { accept: "image/png" })).status, 404);
    // Each says its body depends on what was asked for.
    for (const res of [json, html, await app.get("/nope")]) assert.equal(res.headers.get("vary"), "Accept");
  });

  test("400 for a path that isn't properly percent-encoded", async () => {
    const res = await app.get("/%E0%A4%A");
    assert.equal(res.status, 400);
    assert.equal(res.body, "Bad Request: the path isn't properly percent-encoded\n");
  });

  test("the podcasts alone, which the talks have too", async () => {
    const talks = JSON.parse((await app.get("/talks", { accept: JSON_ })).body) as { podcasts: { title: string; show: string }[] };
    assert.deepEqual(JSON.parse((await app.get("/podcasts", { accept: JSON_ })).body), { command: "ls -lt ~/podcasts", podcasts: talks.podcasts });
    const text = (await app.get("/podcasts")).body;
    assert.ok(text.includes(`${talks.podcasts[0].title} (${talks.podcasts[0].show})\n          `));
    assert.ok((await app.get("/talks")).body.endsWith(`Podcasts:\n${text}`));
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
    // As of the day of each snapshot.
    const data = (name: string) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", `${name}.json`), "utf8"));
    assert.equal(src.asOf, `${data("projects").snapshot}T00:00:00Z`);
    assert.equal(graph.asOf, `${data("contributions").contributions.at(-1).date}T00:00:00Z`);
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

    const refresher = await serve({ fetch: net.fetch, store, refresh: true, now: () => Date.parse("2026-10-06T20:00:00.500Z") });
    await refresher.get("/whoami", { accept: JSON_ });
    assert.deepEqual(saved.get("gems"), { multi_json: 2, multi_xml: 0 });
    await refresher.close();
    // It notes when, which is what the numbers are as of: to the second.
    const later = await serve({ fetch: net.fetch, store });
    assert.equal(JSON.parse((await later.get("/src", { accept: JSON_ })).body).asOf, "2026-10-06T20:00:00Z");
    await later.close();

    const failing = await serve({ fetch: fakeNet({ "https://rubygems.org/api/v1/owners/sferik/gems.json": 503 }).fetch, store, refresh: true });
    assert.equal(JSON.parse((await failing.get("/whoami", { accept: JSON_ })).body).multiDownloads, 2);
    assert.deepEqual(saved.get("gems"), { multi_json: 2, multi_xml: 0 });
    assert.equal(JSON.parse((await failing.get("/src", { accept: JSON_ })).body).asOf, "2026-10-06T20:00:00Z"); // still when it last loaded
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
    const files = nodeFiles(ROOT);
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
    const files = nodeFiles(ROOT);
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
    const errors = stub(t, console, "error", () => {});
    const app = await serve({ offline: true, files: nodeFiles(fs.mkdtempSync(path.join(os.tmpdir(), "sferik-"))) }); // no data/
    const res = await app.get("/whoami", { accept: JSON_ });
    assert.equal(res.status, 500);
    assert.equal(res.body, "Internal Server Error\n");
    assert.equal(errors.calls, 1);
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
    const asOf = async () => JSON.parse((await app.get("/src", { accept: JSON_ })).body).asOf;
    const rubygemsCalls = () => net.calls.filter((c) => c.url.startsWith("https://rubygems.org/")).length;

    assert.equal(await total(), 1);
    assert.equal(await total(), 1);
    assert.equal(rubygemsCalls(), 1); // cached
    assert.equal(await asOf(), "1970-01-01T00:00:00Z");

    gems = [{ name: "multi_json", downloads: 2 }];
    clock += 3600e3;
    assert.equal(await total(), 1); // stale, while it refreshes in the background
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await total(), 2);
    assert.equal(rubygemsCalls(), 2);
    assert.equal(await asOf(), "1970-01-01T01:00:00Z");

    gems = new Error("down");
    clock += 3600e3;
    await total();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await total(), 2); // the failed refresh kept the old value
    assert.equal(await asOf(), "1970-01-01T01:00:00Z"); // which is as old as it was
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
      k in props
        ? validate(spec, props[k], obj[k], `${at}.${k}`)
        : schema.additionalProperties === false
          ? [`${at}.${k}: not in the spec`]
          : typeof schema.additionalProperties === "object"
            ? validate(spec, schema.additionalProperties as Schema, obj[k], `${at}.${k}`)
            : [],
    ),
  ];
}

describe("the OpenAPI spec", () => {
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "openapi.json"), "utf8")) as Schema;
  const paths = spec.paths as Record<string, { get?: { responses: { "200": { content: Record<string, { schema: Schema }> } } } }>;

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
        if (!item.get) continue; // /write only takes POST; the tests below cover it
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
    assert.deepEqual(s({ type: "object", additionalProperties: { type: "string" } }, { b: 1 }), ["$.b: integer, not string"]);
    assert.deepEqual(s({ $ref: "#/components/schemas/Day" }, { date: "2026-10-02", count: 1, level: 9 }), ["$.level: out of range"]);
  });
});

// ------------------------------------------------------------ the graph

describe("the contribution graph's shades", () => {
  test("go by quartile of the days with any, and none is 0", () => {
    const days = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((count, i) => ({ date: `2026-10-0${i + 1}`, count, level: 1 }));
    assert.deepEqual(
      shade(days).map((d) => d.level),
      [0, 1, 1, 2, 2, 3, 3, 4, 4],
    );
    assert.deepEqual(shade([{ date: "2026-10-01", count: 0, level: 2 }]), [{ date: "2026-10-01", count: 0, level: 0 }]);
  });
});

// ------------------------------------------------------- who and write

const TOKEN = "0123456789abcdef";

describe("who's logged in", () => {
  test("a tab checks in with its token and page, and gets a terminal", async () => {
    let time = Date.parse("2026-10-06T20:00:00Z");
    const app = await serve({ offline: true, now: () => time });
    const first = await app.get(`/who?token=${TOKEN}&page=/talks`, { method: "POST" });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.deepEqual(JSON.parse(first.body), { you: "ttys000", users: [{ tty: "ttys000", page: "/talks", login: "2026-10-06T20:00:00.000Z", idle: 0 }] });
    time += 90e3;
    const second = JSON.parse((await app.get(`/who?token=${"f".repeat(16)}&page=/`, { method: "POST" })).body);
    assert.equal(second.you, "ttys001");
    assert.deepEqual(
      second.users.map((u: { tty: string; idle: number }) => [u.tty, u.idle]),
      [
        ["ttys000", 90],
        ["ttys001", 0],
      ],
    );
    // The same token keeps its terminal and login, on another page.
    const again = JSON.parse((await app.get(`/who?token=${TOKEN}&page=/resume`, { method: "POST" })).body);
    assert.deepEqual([again.you, again.users[0].page, again.users[0].login], ["ttys000", "/resume", "2026-10-06T20:00:00.000Z"]);
    // Anyone can ask who's on, as JSON or as who's output; nobody's tokens are in it.
    const json = await app.get("/who", { accept: JSON_ });
    assert.equal(json.headers.get("cache-control"), "no-store");
    assert.deepEqual(
      JSON.parse(json.body).users.map((u: { tty: string }) => u.tty),
      ["ttys000", "ttys001"],
    );
    assert.doesNotMatch(json.body, new RegExp(TOKEN));
    assert.equal((await app.get("/who")).body, "sferik   ttys000  Oct  6 20:00\nsferik   ttys001  Oct  6 20:01\n");
    // Three minutes without checking in logs a terminal out, and frees its number.
    time += 181e3;
    assert.equal((await app.get("/who")).body, ""); // like who, which prints nothing with nobody on
    assert.equal(JSON.parse((await app.get(`/who?token=${"e".repeat(16)}&page=/`, { method: "POST" })).body).you, "ttys000");
    await app.close();
  });

  test("turns away a check-in without a good token or page", async () => {
    const app = await serve({ offline: true });
    for (const query of ["", `?token=${TOKEN}`, `?token=short&page=/`, `?token=${TOKEN}&page=/elsewhere`]) {
      const res = await app.get(`/who${query}`, { method: "POST" });
      assert.equal(res.status, 400, query);
      assert.equal(res.body, "Bad Request: token and page are required\n");
    }
    // As JSON, for a client that prefers it, with a code for which it was.
    for (const [query, code] of [
      ["?token=short&page=/", "bad_token"],
      [`?token=${TOKEN}&page=/elsewhere`, "bad_page"],
    ]) {
      const res = await app.get(`/who${query}`, { method: "POST", accept: JSON_ });
      assert.deepEqual([res.status, res.type, JSON.parse(res.body)], [400, "application/json; charset=utf-8", { error: "token and page are required", code }]);
    }
    await app.close();
  });

  test("has room for a thousand terminals; after that, a tab can only look", async () => {
    const host = createHost(memoryStorage(), () => 0);
    for (let i = 0; i < 1000; i++) await host.beat(`token-${String(i).padStart(10, "0")}`, "/");
    const full = await host.beat("one-too-many-0000", "/");
    assert.deepEqual([full.you, full.users.length, full.users.at(-1)!.tty], [null, 1000, "ttys999"]);
  });
});

describe("write", () => {
  const letters: Letter[] = [];
  const mail = async (l: Letter) => void letters.push(l);
  const post = (app: App, body: string, query = "", headers: Record<string, string> = {}) => app.get(`/write${query}`, { method: "POST", body, headers });
  const asJSON = { accept: JSON_ };
  const said = (res: { status: number; body: string }) => [res.status, JSON.parse(res.body)];

  test("emails the message, with a Reply-To from the address in it, and the terminal it's from", async () => {
    const app = await serve({ offline: true, mail });
    const res = await post(app, "Hi! Write back to someone@example.com.\n", "?tty=ttys004");
    assert.deepEqual([res.status, res.body], [202, "write: message sent to sferik\n"]);
    assert.deepEqual(letters.at(-1), { text: "Hi! Write back to someone@example.com.\n", tty: "ttys004", replyTo: "someone@example.com" });
    await app.close();
  });

  test("answers in JSON for a client that prefers it, with a code for each way it can go wrong", async (t) => {
    stub(t, console, "error", () => {});
    let time = Date.parse("2026-10-06T20:00:00Z");
    const app = await serve({ offline: true, mail, now: () => time });
    assert.deepEqual(said(await post(app, " ", "", asJSON)), [400, { error: "nothing to send", code: "empty" }]);
    assert.deepEqual(said(await post(app, "x".repeat(5001), "", asJSON)), [413, { error: "that's too long for write; try mail", code: "too_long" }]);
    assert.deepEqual(said(await post(app, "hello", "", { ...asJSON, "idempotency-key": "short" })), [
      400,
      { error: "that's no Idempotency-Key; try 16 to 64 letters, digits, hyphens, and underscores", code: "bad_key" },
    ]);
    const sent = await post(app, "hello", "", asJSON);
    assert.deepEqual([...said(sent), sent.type], [202, { message: "message sent to sferik" }, "application/json; charset=utf-8"]);
    assert.deepEqual(said(await post(app, "again", "", asJSON)), [429, { error: "one message a minute, please", code: "busy" }]);
    for (let i = 0; i < 19; i++) {
      time += 60e3;
      await post(app, `message ${i}`);
    }
    time += 60e3;
    assert.deepEqual(said(await post(app, "too many", "", asJSON)), [
      429,
      { error: "sferik has had enough messages for today; try again tomorrow", code: "full" },
    ]);
    await app.close();

    const nowhere = await serve({ offline: true });
    assert.deepEqual(said(await post(nowhere, "hello", "", asJSON)), [503, { error: "sferik isn't taking messages here", code: "unavailable" }]);
    await nowhere.close();
    const broken = await serve({ offline: true, mail: () => Promise.reject(new Error("no route")) });
    const lost = await post(broken, "hello", "", asJSON);
    assert.deepEqual(said(lost), [502, { error: "the message didn't go through; try again later", code: "undelivered" }]);
    await broken.close();
  });

  test("with a key, a message sent again isn't emailed twice: for a day", async () => {
    let time = Date.parse("2026-10-06T20:00:00Z");
    const app = await serve({ offline: true, mail, now: () => time });
    const key = { "idempotency-key": "0f8fad5b-d9cb-469f-a165-70867728950e" };
    const before = letters.length;
    assert.equal((await post(app, "once", "", key)).status, 202);
    const again = await post(app, "once", "", key); // within the minute, when another message would be turned away
    assert.deepEqual([again.status, again.body, letters.length - before], [202, "write: message sent to sferik\n", 1]);
    assert.equal((await post(app, "another", "", { "idempotency-key": "another-key-0000" })).status, 429);
    time += 864e5 - 1;
    assert.deepEqual([(await post(app, "once", "", key)).status, letters.length - before], [202, 1]);
    time += 1; // a day on, the key is forgotten, and the message is a new one
    assert.deepEqual([(await post(app, "once", "", key)).status, letters.length - before], [202, 2]);
    await app.close();
  });

  test("forgets the key of a message that didn't go through, so sending it again sends it", async (t) => {
    stub(t, console, "error", () => {});
    let time = Date.parse("2026-10-06T20:00:00Z");
    let down = true;
    const sent: Letter[] = [];
    const flaky = async (l: Letter) => {
      if (down) throw new Error("no route");
      sent.push(l);
    };
    const app = await serve({ offline: true, mail: flaky, now: () => time });
    const key = { "idempotency-key": "0f8fad5b-d9cb-469f-a165-70867728950e" };
    const lost = await post(app, "hello", "", key);
    assert.deepEqual([lost.status, lost.headers.get("retry-after")], [502, "60"]);
    down = false;
    time += 60e3; // when it said to
    assert.deepEqual([(await post(app, "hello", "", key)).status, sent.length], [202, 1]);
    await app.close();
  });

  test("rations messages: one a minute from an address, and twenty a day", async () => {
    let time = Date.parse("2026-10-06T20:00:00Z");
    const app = await serve({ offline: true, mail, now: () => time });
    assert.equal((await post(app, "one", "?tty=nonsense")).status, 202);
    assert.equal(letters.at(-1)!.tty, null); // not a terminal's name
    const busy = await post(app, "two");
    assert.deepEqual([busy.status, busy.body, busy.headers.get("retry-after")], [429, "write: one message a minute, please\n", "60"]);
    for (let i = 0; i < 19; i++) {
      time += 60e3;
      assert.equal((await post(app, `message ${i}`)).status, 202);
    }
    time += 60e3;
    const full = await post(app, "too many");
    assert.deepEqual(
      [full.status, full.body, full.headers.get("retry-after")],
      [429, "write: sferik has had enough messages for today; try again tomorrow\n", "13200"], // 20:20 UTC, so 3 hours 40 minutes
    );
    time += 864e5; // the next day
    assert.equal((await post(app, "tomorrow")).status, 202);
    await app.close();
  });

  test("turns away nothing, too much, and everything when there's no way to send it", async () => {
    const app = await serve({ offline: true, mail });
    assert.deepEqual([(await post(app, "  \n")).status, (await post(app, "\n")).body], [400, "write: nothing to send\n"]);
    const long = await post(app, "x".repeat(5001));
    assert.deepEqual([long.status, long.body], [413, "write: that's too long for write; try mail\n"]);
    await app.close();
    const nowhere = await serve({ offline: true });
    const res = await post(nowhere, "hello");
    assert.deepEqual([res.status, res.body], [503, "write: sferik isn't taking messages here\n"]);
    await nowhere.close();
  });

  test("says so when the email doesn't go through", async (t) => {
    stub(t, console, "error", () => {});
    const app = await serve({
      offline: true,
      mail: async () => {
        throw new Error("no route");
      },
    });
    const res = await post(app, "hello");
    assert.deepEqual([res.status, res.body], [502, "write: the message didn't go through; try again later\n"]);
    await app.close();
  });

  test("the email: plain text in base64, signed, from sferik.net", () => {
    const date = new Date("2026-10-06T20:00:00Z");
    const raw = letter(
      { text: "Grüße, ".repeat(20), tty: "ttys002", replyTo: "a@b.co" },
      { from: "write@sferik.net", to: "sferik@gmail.com", date, id: "abc" },
    );
    const [head, body] = raw.split("\r\n\r\n");
    assert.equal(
      head,
      [
        "From: sferik.net <write@sferik.net>",
        "To: sferik@gmail.com",
        "Reply-To: a@b.co",
        "Subject: Message from ttys002",
        "Date: Tue, 06 Oct 2026 20:00:00 GMT",
        "Message-ID: <abc@sferik.net>",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
      ].join("\r\n"),
    );
    assert.ok(body.split("\r\n").every((line) => line.length <= 76));
    assert.equal(Buffer.from(body, "base64").toString(), `${"Grüße, ".repeat(20)}\n\n-- \nSent with write from ttys002 on sferik.net\n`);
    const anonymous = letter({ text: "hi", tty: null, replyTo: null }, { from: "f@x.y", to: "t@x.y", date, id: "x" });
    assert.match(anonymous, /\r\nSubject: Message from sferik\.net\r\n/);
    assert.doesNotMatch(anonymous, /Reply-To/);
    assert.match(Buffer.from(anonymous.split("\r\n\r\n")[1], "base64").toString(), /from a terminal on sferik\.net/);
  });
});

// ---------------------------------------------------------- the binary

test("node src/server.ts starts, serves, and shuts down on SIGTERM", async () => {
  const child = spawn("node", [path.join(ROOT, "src/server.ts")], { env: { ...process.env, PORT: "0", SFERIK_OFFLINE: "1" } });
  const url = await new Promise<string>((resolve) => child.stdout.once("data", (d) => resolve(String(d).match(/http:\/\/\S+/)![0])));
  const res = await fetch(url + "/name", { headers: { accept: JSON_ } });
  assert.equal((await res.json()).commit, "8c0d698");
  // write's messages, printed rather than emailed.
  const printed = new Promise<string>((resolve) => child.stdout.once("data", (d) => resolve(String(d))));
  assert.equal((await fetch(url + "/write", { method: "POST", body: "hello" })).status, 202);
  assert.match(await printed, /write: \{ text: 'hello', tty: null, replyTo: null \}/);
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
    assert.match(text, /\(sferik\.net {20,}January 2027 {20,}2 of 2\) Tj/); // the current month
    assert.match((await app.get("/resume.txt")).body, /\nsferik\.net {20,}January 2027 {20,}SFERIK\(1\)\n$/);
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
    assert.match(doc, /\\href\{https:\/\/sferik\.net\/talks\}\{\\mbox\{sferik\.net\/talks\}\}/);
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
