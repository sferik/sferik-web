// Tests for src/worker.ts, the Cloudflare Workers entry point, with stand-ins
// for its bindings (static assets, KV, the Durable Object, and email) and for
// RubyGems and GitHub. Run with `bun run test:server`, which also stands in
// for the cloudflare: modules (tests/support/cloudflare.ts).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import worker, { Mbp, type Env } from "../../src/worker.ts";
import { memoryStorage } from "../../src/server.ts";
import { stub } from "../support/stub.ts";

const PUBLIC = path.join(import.meta.dirname, "..", "..", "public");

// The bindings: ASSETS serves public/ from disk, LIVE is KV in a Map, MBP is
// one Mbp with its storage in a Map, and MAIL keeps what it's sent.
// The rate limits allow everything, until a test says otherwise.
type Sent = { from: string; to: string; raw: string };
function env(): Env & { kv: Map<string, string>; sent: Sent[]; limited: Set<string> } {
  const kv = new Map<string, string>();
  const sent: Sent[] = [];
  const limited = new Set<string>();
  const ration = { limit: async ({ key }: { key: string }) => ({ success: !limited.has(key) }) };
  const mbp = new Mbp({ storage: memoryStorage() }, { WRITES: ration } as Env);
  return {
    kv,
    sent,
    limited,
    CHECK_INS: ration,
    WRITES: ration,
    MBP: { idFromName: (name) => name, get: () => mbp },
    MAIL: { send: async (message) => void sent.push(message as unknown as Sent) },
    ASSETS: {
      async fetch(request) {
        try {
          return new Response(await fs.readFile(path.join(PUBLIC, new URL(request.url).pathname)));
        } catch {
          return new Response("Not Found", { status: 404 });
        }
      },
    },
    LIVE: {
      get: async (key) => (kv.has(key) ? JSON.parse(kv.get(key)!) : null),
      put: async (key, value) => void kv.set(key, value),
    },
  };
}

// What the runtime hands each request: here, somewhere to keep what's still to be done.
const waiting: Promise<unknown>[] = [];
const CTX = { waitUntil: (promise: Promise<unknown>) => void waiting.push(promise) };

const get = (e: Env, url: string, accept?: string, method = "GET") =>
  worker.fetch(new Request(`https://sferik.net${url}`, { method, headers: accept ? { accept } : {} }), e, CTX);
const post = (e: Env, url: string, body?: string, ip = "192.0.2.1", headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://sferik.net${url}`, { method: "POST", body, headers: { "cf-connecting-ip": ip, ...headers } }), e, CTX);
const json = async (e: Env, url: string) => (await get(e, url, "application/json")).json() as Promise<Record<string, unknown>>;

// RubyGems and GitHub, for the scheduled refresh.
const UPSTREAM: Record<string, unknown> = {
  "https://rubygems.org/api/v1/owners/sferik/gems.json": [
    { name: "multi_json", downloads: 7 },
    { name: "multi_xml", downloads: 0 },
  ],
  "https://github-contributions-api.jogruber.de/v4/sferik?y=last": { contributions: [{ date: "2026-10-01", count: 3, level: 2 }] },
  "https://api.github.com/users/sferik/events/public?per_page=100": [
    { type: "PushEvent", repo: { name: "sferik/x-ruby" }, payload: { head: "abc1234" }, created_at: "2026-10-01T12:00:00Z" },
  ],
};
const upstream = async (input: string | URL | Request) => {
  const url = String(input);
  return Response.json(url.startsWith("https://api.github.com/repos/") ? { stargazers_count: 9 } : UPSTREAM[url]);
};

describe("the Worker", () => {
  test("serves pages, data, and text, negotiated like the Node server", async () => {
    const e = env();
    const page = await get(e, "/", "text/html");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type")!, /^text\/html/);
    assert.match(await page.text(), /data-page="home"/);
    assert.equal(((await json(e, "/")) as { profile: { name: string } }).profile.name, "Erik Berlin");
    assert.match(await (await get(e, "/whoami")).text(), /^I've spent nearly two decades/); // no Accept header: text
    assert.equal((await get(e, "/whoami", "image/png")).status, 406);
  });

  test("reads figlet's font for the first home page, and not again for the next", async () => {
    const e = env();
    await get(e, "/", "text/html");
    const fetched: string[] = [];
    const assets = e.ASSETS.fetch;
    e.ASSETS.fetch = (request) => {
      fetched.push(new URL(request.url).pathname);
      return assets(request);
    };
    assert.match(await (await get(e, "/", "text/html")).text(), /<pre class="figlet"/);
    assert.deepEqual(fetched, ["/index.html"]);
  });

  test("serves the resume as a PDF, as bytes", async () => {
    const res = await get(env(), "/resume.pdf");
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.equal(
      Buffer.from(await res.arrayBuffer())
        .subarray(0, 8)
        .toString(),
      "%PDF-1.4",
    );
  });

  test("serves static files from the assets, without a modification time", async () => {
    const e = env();
    const css = await get(e, "/site.css");
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type")!, /^text\/css/);
    assert.equal(css.headers.get("last-modified"), null);
    assert.equal((await get(e, "/missing.png")).status, 404);
    assert.match(await (await get(e, "/missing", "text/html")).text(), /<title>/); // the 404 page, from the assets
  });

  test("answers If-None-Match with 304 Not Modified, without a body", async () => {
    const e = env();
    const first = await get(e, "/whoami", "application/json");
    const tag = first.headers.get("etag")!;
    const again = await worker.fetch(new Request("https://sferik.net/whoami", { headers: { accept: "application/json", "if-none-match": tag } }), e, CTX);
    assert.equal(again.status, 304);
    assert.equal(await again.text(), "");
  });

  test("passes the deployed commit and time to /version", async () => {
    const e = { ...env(), COMMIT: "abc1234def", DEPLOYED: "2026-10-05T21:40:00Z" };
    const v = (await (await get(e, "/version")).json()) as { commit: string; deployed: string };
    assert.equal(v.commit, "abc1234def");
    assert.equal(v.deployed, "2026-10-05T21:40:00Z");
  });

  test("answers OPTIONS with an empty 204, and HEAD without a body", async () => {
    const e = env();
    const options = await get(e, "/whoami", undefined, "OPTIONS");
    assert.equal(options.status, 204);
    assert.equal(options.body, null);
    const head = await get(e, "/whoami", "application/json", "HEAD");
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });

  test("serves the snapshots until the scheduled refresh fills KV, then live values", async (t) => {
    const e = env();
    const snapshot = (await json(e, "/src")) as { live: boolean; asOf: string };
    assert.equal(snapshot.live, false);
    assert.match(snapshot.asOf, /T00:00:00Z$/); // the day of the snapshot

    const fetch = stub(t, globalThis, "fetch", upstream as typeof globalThis.fetch);
    await worker.scheduled(undefined, e);
    assert.ok(fetch.calls > 3);
    assert.equal(e.kv.size, 1); // every value in one entry, written once

    const src = (await json(e, "/src")) as { live: boolean; total: { downloads: number }; asOf: string };
    assert.deepEqual([src.live, src.total.downloads], [true, 7]);
    assert.ok(Date.now() - Date.parse(src.asOf) < 60e3); // as of the refresh
    const graph = (await json(e, "/contributions")) as { live: boolean; total: number; lastPush: { sha: string } };
    assert.deepEqual([graph.live, graph.total, graph.lastPush.sha], [true, 3, "abc1234"]);
    assert.equal((await json(e, "/whoami")).multiDownloads, 7);
  });

  test("a refresh keeps the old value of what it couldn't load, and drops what nothing asks for any more", async (t) => {
    const errors = stub(t, console, "error", () => {});
    const e = env();
    // What an earlier version kept: a star count for each repository, and downloads that are still wanted.
    e.kv.set(
      "live",
      JSON.stringify({ "stars:sferik/multi_json": 27, "at:stars:sferik/multi_json": 1, gems: { multi_json: 5, multi_xml: 0 }, "at:gems": 1000 }),
    );
    const down = (async (input: string | URL | Request) =>
      String(input).startsWith("https://rubygems.org/") ? new Response("", { status: 503 }) : upstream(input)) as typeof globalThis.fetch;
    stub(t, globalThis, "fetch", down);
    await worker.scheduled(undefined, e);
    const saved = JSON.parse(e.kv.get("live")!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(saved).sort(), ["at:contributions", "at:gems", "at:push", "at:stars", "contributions", "gems", "push", "stars"]);
    assert.deepEqual([saved.gems, saved["at:gems"]], [{ multi_json: 5, multi_xml: 0 }, 1000]);
    assert.equal((await json(e, "/whoami")).multiDownloads, 5);
    assert.equal(errors.calls, 1); // it says what it couldn't load, for the log
  });

  test("keeps who's logged in in the Durable Object, which every request shares", async () => {
    const e = env();
    const res = await post(e, "/who?token=0123456789abcdef&page=/talks");
    assert.equal(((await res.json()) as { you: string }).you, "ttys000");
    assert.match(await (await get(e, "/who")).text(), /^sferik {3}ttys000 /);
  });

  test("emails write's messages, from write@sferik.net to the site's address, one a minute from an address", async () => {
    const e = env();
    const res = await post(e, "/write?tty=ttys001", "Hello from the Worker. Reach me at someone@example.com");
    assert.deepEqual([res.status, await res.text()], [202, "write: message sent to sferik\n"]);
    const [message] = e.sent;
    assert.deepEqual([message.from, message.to], ["write@sferik.net", "sferik@gmail.com"]);
    assert.match(message.raw, /\r\nReply-To: someone@example\.com\r\nSubject: Message from ttys001\r\n/);
    assert.match(message.raw, /\r\nMessage-ID: <[\w-]+@sferik\.net>\r\n/);
    assert.match(Buffer.from(message.raw.split("\r\n\r\n")[1], "base64").toString(), /^Hello from the Worker\./);
    const busy = await post(e, "/write", "again");
    assert.deepEqual([busy.status, busy.headers.get("retry-after")], [429, "60"]);
    assert.equal((await post(e, "/write", "from elsewhere", "192.0.2.2")).status, 202);
  });

  test("rations check-ins and write's messages by address, with Cloudflare's rate limits", async () => {
    const e = env();
    e.limited.add("192.0.2.9");
    const who = await post(e, "/who?token=0123456789abcdef&page=/", undefined, "192.0.2.9");
    assert.deepEqual([who.status, who.headers.get("retry-after")], [429, "60"]);
    // A message from an address the Durable Object has no memory of, but Cloudflare does.
    const write = await post(e, "/write", "hello", "192.0.2.9");
    assert.deepEqual([write.status, write.headers.get("retry-after"), e.sent.length], [429, "60", 0]);
    assert.equal((await post(e, "/who?token=0123456789abcdef&page=/", undefined, "192.0.2.1")).status, 200);
  });

  test("turns away a POST from another site's page, and takes one from its own", async () => {
    const e = env();
    const from = (origin: string) => post(e, "/who?token=0123456789abcdef&page=/", undefined, "192.0.2.1", { origin });
    assert.equal((await from("https://evil.example")).status, 403);
    assert.equal((await from("https://sferik.net")).status, 200);
    assert.equal((await post(e, "/write", "hello", "192.0.2.1", { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal(e.sent.length, 0);
  });

  test("reads a body as it arrives, and turns away one that's too long without keeping it", async () => {
    const e = env();
    const chunks = Array.from({ length: 6 }, () => new TextEncoder().encode("x".repeat(1000)));
    const body = new ReadableStream<Uint8Array>({ pull: (controller) => (chunks.length ? controller.enqueue(chunks.pop()!) : controller.close()) });
    const request = new Request("https://sferik.net/write", {
      method: "POST",
      body,
      headers: { "cf-connecting-ip": "192.0.2.1" },
      duplex: "half",
    } as RequestInit);
    const res = await worker.fetch(request, e, CTX);
    assert.deepEqual([res.status, chunks.length, e.sent.length], [413, 0, 0]);
    // In pieces, a message is still one message.
    const pieces = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of ["Hello, ", "in two pieces"]) controller.enqueue(new TextEncoder().encode(piece));
        controller.close();
      },
    });
    const sent = new Request("https://sferik.net/write", {
      method: "POST",
      body: pieces,
      headers: { "cf-connecting-ip": "192.0.2.1" },
      duplex: "half",
    } as RequestInit);
    assert.equal((await worker.fetch(sent, e, CTX)).status, 202);
    assert.match(Buffer.from(e.sent[0].raw.split("\r\n\r\n")[1], "base64").toString(), /^Hello, in two pieces\n/);
  });

  test("keeps what the API says in Cloudflare's cache, by URL and Accept, for as long as it's good for", async (t) => {
    // The cache, as the runtime has it: caches.default. It answers If-None-Match itself.
    const kept = new Map<string, Response>();
    const asked: (string | null)[] = [];
    // What it hands back says to keep it for four hours, whatever it said when
    // it was kept: Cloudflare's Browser Cache TTL, as the zone has it.
    const cache = {
      async match(request: Request) {
        asked.push(request.headers.get("if-none-match"));
        const found = kept.get(request.url)?.clone();
        if (!found) return undefined;
        const handed = new Response(found.body, found);
        handed.headers.set("cache-control", "public, max-age=14400");
        return handed;
      },
      put: async (request: Request, response: Response) => void kept.set(request.url, response),
    };
    const global = globalThis as { caches?: unknown };
    const before = global.caches;
    global.caches = { default: cache };
    t.after(() => void (global.caches = before));

    const e = env();
    const first = await (await get(e, "/whoami", "application/json")).text();
    await Promise.all(waiting);
    assert.equal(kept.size, 1);
    // The same again comes from the cache: KV isn't read, and it doesn't see a change.
    // It says how long it's good for as the first did, not as the cache does.
    e.LIVE.get = () => Promise.reject(new Error("KV was read"));
    const again = await get(e, "/whoami", "application/json");
    assert.deepEqual([again.headers.get("cache-control"), again.headers.get("x-own-cache-control")], ["public, max-age=300", null]);
    assert.equal(await again.text(), first);
    // So does the same asked for in other words, or with a query that changes nothing.
    assert.equal(await (await get(e, "/whoami", "Application/JSON; q=1")).text(), first);
    assert.equal(await (await get(e, "/whoami?utm_source=elsewhere", "application/json")).text(), first);
    await Promise.all(waiting);
    assert.equal(kept.size, 1);
    // Asked for another way, it's another entry; so is another query, of what reads its query.
    e.LIVE.get = async () => null;
    assert.match(await (await get(e, "/whoami", "text/plain")).text(), /^I've spent/);
    await get(e, "/.well-known/webfinger?resource=acct:sferik@sferik.net");
    await get(e, "/.well-known/webfinger?resource=acct:sferik@sferik.com");
    await Promise.all(waiting);
    assert.equal(kept.size, 4);
    // If-None-Match goes to the cache, which answers it.
    await worker.fetch(new Request("https://sferik.net/whoami", { headers: { accept: "application/json", "if-none-match": '"abc"' } }), e, CTX);
    assert.equal(asked.at(-1), '"abc"');
    // Who's on is kept too, for the few seconds it says: the Durable Object isn't asked again.
    assert.equal((await get(e, "/who", "application/json")).headers.get("cache-control"), "public, max-age=5");
    await Promise.all(waiting);
    assert.equal(kept.size, 5);
    const mbp = e.MBP.get;
    e.MBP.get = () => assert.fail("the Durable Object was asked");
    const on = await get(e, "/who", "application/json");
    assert.equal(on.headers.get("cache-control"), "public, max-age=5"); // and not for four hours
    assert.deepEqual(await on.json(), { users: [] });
    e.MBP.get = mbp;
    // And the motto, which changes only with a deploy, for the hour it says.
    assert.equal((await get(e, "/.signature", "text/plain")).headers.get("cache-control"), "public, max-age=3600");
    await Promise.all(waiting);
    assert.equal(kept.size, 6);
    // Not kept: what says to check every time (but for a page), what's not acceptable,
    // and what a POST says.
    for (const [url, accept] of [
      ["/version", "application/json"],
      ["/whoami", "image/png"],
    ])
      await get(e, url, accept);
    await post(e, "/who?token=0123456789abcdef&page=/");
    await Promise.all(waiting);
    assert.equal(kept.size, 6);
    // What HEAD asks is answered from what GET kept, without the body, and keeps nothing itself.
    e.LIVE.get = () => Promise.reject(new Error("KV was read"));
    const head = await get(e, "/whoami", "application/json", "HEAD");
    assert.deepEqual(
      [head.status, head.headers.get("cache-control"), head.headers.get("etag"), await head.text()],
      [200, "public, max-age=300", again.headers.get("etag"), ""],
    );
    e.LIVE.get = async () => null;
    assert.equal((await get(e, "/name", "application/json", "HEAD")).status, 200);
    await Promise.all(waiting);
    assert.equal(kept.size, 6);
  });

  test("gzips what Cloudflare sends as it is, for what takes gzip, on its way out and not in the cache", async (t) => {
    // The cache, which answers If-None-Match itself, with a 304 that has the headers of what it kept.
    const kept = new Map<string, Response>();
    const cache = {
      async match(request: Request) {
        const found = kept.get(request.url)?.clone();
        // A weak tag (W/) matches the one it was made from, as it does for Cloudflare's.
        const same = found && request.headers.get("if-none-match")?.replace(/^W\//, "") === found.headers.get("etag");
        return same ? new Response(null, { status: 304, headers: found.headers }) : found;
      },
      put: async (request: Request, response: Response) => void kept.set(request.url, response),
    };
    const global = globalThis as { caches?: unknown };
    const before = global.caches;
    global.caches = { default: cache };
    t.after(() => void (global.caches = before));

    // A request as Cloudflare hands it over: what the client said it takes is in cf, not in the headers.
    const e = env();
    const ask = (url: string, accept: string, takes?: string) =>
      worker.fetch(
        Object.assign(new Request(`https://sferik.net${url}`, { headers: { accept } }), takes === undefined ? {} : { cf: { clientAcceptEncoding: takes } }),
        e,
        CTX,
      );
    const encoding = async (url: string, accept: string, takes?: string) => (await ask(url, accept, takes)).headers.get("content-encoding");

    // The API's description, the feed, WebFinger's answer, the contact card, and the resume as LaTeX and as a PDF.
    const left: [string, string][] = [
      ["/openapi.json", "*/*"],
      ["/talks.atom", "*/*"],
      ["/.well-known/webfinger?resource=acct:sferik@sferik.net", "*/*"],
      ["/finger", "text/vcard"],
      ["/resume", "application/x-latex"],
      ["/resume", "application/pdf"],
    ];
    for (const [url, accept] of left) assert.equal(await encoding(url, accept, "gzip, br"), "gzip", url);
    await Promise.all(waiting);
    // What's kept isn't said to be gzip, or the runtime would compress it, and again when it's sent.
    assert.ok(kept.size >= left.length);
    for (const response of kept.values()) assert.equal(response.headers.get("content-encoding"), null);
    // From what's kept, it's gzip all the same, with the body there was, and to be kept apart from one that isn't.
    const again = await ask("/talks.atom", "*/*", "br, gzip");
    assert.equal(again.headers.get("content-encoding"), "gzip");
    assert.equal(again.headers.get("vary"), "Accept-Encoding");
    // Its tag is a weak one, since it's not byte for byte what the tag was made from: what's sent as it is keeps that.
    const strong = (await ask("/talks.atom", "*/*", "")).headers.get("etag")!;
    assert.match(strong, /^"[\da-f]+-[\da-f]+"$/);
    assert.equal(again.headers.get("etag"), `W/${strong}`);
    assert.match(await again.text(), /^<\?xml/);
    assert.equal((await ask("/resume", "application/pdf", "gzip")).headers.get("vary"), "Accept, Accept-Encoding");

    // Not for what doesn't take gzip (curl, unless it's told to), or doesn't say what it takes.
    for (const takes of ["", "identity", "br", undefined]) assert.equal(await encoding("/openapi.json", "*/*", takes), null);
    assert.equal(await (await ask("/resume", "application/pdf", "")).text().then((pdf) => pdf.slice(0, 8)), "%PDF-1.4");
    // Nor for what Cloudflare compresses itself, or what isn't a 200.
    assert.equal(await encoding("/talks", "application/json", "gzip"), null);
    assert.equal(await encoding("/.well-known/webfinger?resource=acct:nobody@example.com", "*/*", "gzip"), null);
    // Asked for again with the weak tag, from the cache or (the first time, for the contact card by its suffix) the app.
    const tag = (await ask("/openapi.json", "*/*", "gzip")).headers.get("etag")!;
    assert.match(tag, /^W\//);
    const first = await worker.fetch(
      Object.assign(
        new Request("https://sferik.net/finger.vcf", { headers: { "if-none-match": `W/${(await ask("/finger", "text/vcard", "")).headers.get("etag")}` } }),
        {
          cf: { clientAcceptEncoding: "gzip" },
        },
      ),
      e,
      CTX,
    );
    assert.equal(first.status, 304);
    const unchanged = await worker.fetch(
      Object.assign(new Request("https://sferik.net/openapi.json", { headers: { "if-none-match": tag } }), { cf: { clientAcceptEncoding: "gzip" } }),
      e,
      CTX,
    );
    assert.deepEqual([unchanged.status, unchanged.headers.get("content-encoding")], [304, null]);
  });

  test("keeps what wasn't found in Cloudflare's cache for a minute, and says nothing of that to whoever asked", async (t) => {
    const kept = new Map<string, Response>();
    const cache = {
      match: async (request: Request) => kept.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => void kept.set(request.url, response),
    };
    const global = globalThis as { caches?: unknown };
    const before = global.caches;
    global.caches = { default: cache };
    t.after(() => void (global.caches = before));

    const e = env();
    const first = await get(e, "/wp-login.php", "application/json");
    assert.deepEqual([first.status, first.headers.get("cache-control")], [404, null]);
    const body = await first.text();
    await Promise.all(waiting);
    assert.deepEqual(
      [...kept.values()].map((response) => [response.status, response.headers.get("cache-control")]),
      [[404, "public, max-age=60"]],
    );
    e.ASSETS.fetch = () => assert.fail("the assets were read");
    const second = await get(e, "/wp-login.php", "application/json");
    assert.deepEqual([second.status, second.headers.get("cache-control"), second.headers.get("x-own-cache-control")], [404, null, null]);
    assert.equal(await second.text(), body);
  });

  test("keeps a deploy's scripts and style in Cloudflare's cache, at the commit's URLs, for good", async (t) => {
    const kept = new Map<string, Response>();
    const cache = {
      match: async (request: Request) => kept.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => void kept.set(request.url, response),
    };
    const global = globalThis as { caches?: unknown };
    const before = global.caches;
    global.caches = { default: cache };
    t.after(() => void (global.caches = before));

    const e = env();
    e.COMMIT = "abc1234";
    assert.match(await (await get(e, "/", "text/html")).text(), /<script type="module" src="\/v\/abc1234\/site\.js"><\/script>/);
    const first = await get(e, "/v/abc1234/site.css", "text/css,*/*;q=0.1");
    assert.deepEqual([first.status, first.headers.get("cache-control")], [200, "public, max-age=31536000, immutable"]);
    const css = await first.text();
    await Promise.all(waiting);
    e.ASSETS.fetch = () => assert.fail("the assets were read");
    const second = await get(e, "/v/abc1234/site.css", "text/css,*/*;q=0.1");
    assert.deepEqual([second.headers.get("cache-control"), await second.text()], ["public, max-age=31536000, immutable", css]);
  });

  test("keeps a page in Cloudflare's cache, though it tells browsers to check every time, until the next deploy", async (t) => {
    const kept = new Map<string, Response>();
    const cache = {
      // Asked with If-None-Match, the cache answers 304 Not Modified, with the headers it kept.
      match: async (request: Request) => {
        const found = kept.get(request.url)?.clone();
        return found && request.headers.has("if-none-match") ? new Response(null, { status: 304, headers: found.headers }) : found;
      },
      put: async (request: Request, response: Response) => void kept.set(request.url, response),
    };
    const global = globalThis as { caches?: unknown };
    const before = global.caches;
    global.caches = { default: cache };
    t.after(() => void (global.caches = before));

    const e = env();
    e.COMMIT = "abc1234";
    const first = await get(e, "/", "text/html");
    assert.equal(first.headers.get("cache-control"), "no-cache");
    const page = await first.text();
    await Promise.all(waiting);
    assert.deepEqual(
      [...kept.values()].map((response) => response.headers.get("cache-control")),
      ["public, max-age=3660"],
    );
    // The same again comes from the cache, without being built, and says what the first did.
    const assets = e.ASSETS.fetch;
    let built = 0;
    e.ASSETS.fetch = (request) => (built++, assets(request));
    const second = await get(e, "/", "text/html");
    assert.deepEqual([second.headers.get("cache-control"), second.headers.get("x-own-cache-control"), await second.text()], ["no-cache", null, page]);
    assert.deepEqual([second.headers.get("x-kept-at"), second.headers.get("x-good-for")], [null, null]);
    const unchanged = await worker.fetch(
      new Request("https://sferik.net/", { headers: { accept: "text/html", "if-none-match": first.headers.get("etag")! } }),
      e,
      CTX,
    );
    assert.deepEqual([unchanged.status, unchanged.headers.get("cache-control")], [304, "no-cache"]);
    // A deploy leaves what was kept behind.
    assert.equal(built, 0);
    e.COMMIT = "def5678";
    assert.equal(await (await get(e, "/", "text/html")).text(), page.replaceAll("/v/abc1234/", "/v/def5678/")); // with its own scripts
    assert.notEqual(built, 0);
  });

  test("sends a page that's older than a minute at once, and builds a new one for the next reader", async (t) => {
    const kept = new Map<string, Response>();
    const cache = {
      match: async (request: Request) => {
        const found = kept.get(request.url)?.clone();
        return found && request.headers.has("if-none-match") ? new Response(null, { status: 304, headers: found.headers }) : found;
      },
      put: async (request: Request, response: Response) => void kept.set(request.url, response),
    };
    const global = globalThis as { caches?: unknown };
    const before = global.caches;
    global.caches = { default: cache };
    t.after(() => void (global.caches = before));
    let clock = Date.UTC(2026, 9, 7);
    stub(t, Date, "now", () => clock);

    const e = env();
    const page = await (await get(e, "/", "text/html")).text();
    await Promise.all(waiting);
    // The live data changes, which a page shows: within the minute, the one kept is good, and nothing is built.
    e.kv.set("live", JSON.stringify({ gems: { multi_json: 7, multi_xml: 0 } }));
    const assets = e.ASSETS.fetch;
    let built = 0;
    e.ASSETS.fetch = (request) => (built++, assets(request));
    clock += 59_999;
    assert.equal(await (await get(e, "/", "text/html")).text(), page);
    await Promise.all(waiting);
    assert.equal(built, 0);
    // After it, the reader still gets the one kept, and the next reader the one that's built meanwhile.
    clock += 1;
    const stale = await get(e, "/", "text/html");
    assert.deepEqual([stale.headers.get("cache-control"), await stale.text()], ["no-cache", page]);
    await Promise.all(waiting);
    await Promise.all(waiting); // what was built is kept
    assert.notEqual(built, 0);
    const next = await (await get(e, "/", "text/html")).text();
    assert.notEqual(next, page);
    assert.match(next, /"multiDownloads":7\b/);
    // Readers who come while one is being built get the one kept, and no page is built for each of them.
    clock += 60_000;
    built = 0;
    const entry = [...kept.keys()].find((url) => !url.includes("building"))!;
    const unbuilt = kept.get(entry)!.clone();
    assert.equal(await (await get(e, "/", "text/html")).text(), next);
    await Promise.all(waiting);
    await Promise.all(waiting);
    const once = built;
    assert.notEqual(once, 0);
    kept.set(entry, unbuilt.clone()); // as if the new one weren't done yet
    clock += 29_999;
    assert.equal(await (await get(e, "/", "text/html")).text(), next);
    await Promise.all(waiting);
    assert.equal(built, once);
    // One that's been half a minute at it never finished: the next reader has another built.
    clock += 1;
    await get(e, "/", "text/html");
    await Promise.all(waiting);
    await Promise.all(waiting);
    assert.equal(built, 2 * once);
    // Whatever asks for an old page has a whole new one built: a HEAD, or a request that has the old one.
    for (const [method, headers] of [
      ["HEAD", {}],
      ["GET", { "if-none-match": stale.headers.get("etag")! }],
    ] as const) {
      clock += 60_000;
      e.kv.set("live", JSON.stringify({ gems: { multi_json: clock, multi_xml: 0 } }));
      const res = await worker.fetch(new Request("https://sferik.net/", { method, headers: { accept: "text/html", ...headers } }), e, CTX);
      assert.equal(await res.text(), "");
      await Promise.all(waiting);
      await Promise.all(waiting);
      assert.ok((await (await get(e, "/", "text/html")).text()).includes(`"multiDownloads":${clock}`), method);
    }
  });

  test("sends what the API says at once when it's older than it's good for, and builds it again for the next to ask", async (t) => {
    const kept = new Map<string, Response>();
    const cache = {
      match: async (request: Request) => {
        const found = kept.get(request.url)?.clone();
        return found && request.headers.has("if-none-match") ? new Response(null, { status: 304, headers: found.headers }) : found;
      },
      put: async (request: Request, response: Response) => void kept.set(request.url, response),
    };
    const global = globalThis as { caches?: unknown };
    const before = global.caches;
    global.caches = { default: cache };
    t.after(() => void (global.caches = before));
    let clock = Date.UTC(2026, 9, 7);
    stub(t, Date, "now", () => clock);

    const e = env();
    const first = await get(e, "/whoami", "application/json");
    const body = await first.text();
    await Promise.all(waiting);
    // It's kept for an hour past the five minutes it's good for.
    assert.deepEqual(
      [...kept.values()].map((response) => response.headers.get("cache-control")),
      ["public, max-age=3900"],
    );
    // The live data changes. Within the five minutes, what's kept is good, and KV isn't read.
    e.kv.set("live", JSON.stringify({ gems: { multi_json: 7, multi_xml: 0 } }));
    const live = e.LIVE.get;
    let read = 0;
    e.LIVE.get = (key, type) => (read++, live(key, type));
    clock += 299_999;
    assert.equal(await (await get(e, "/whoami", "application/json")).text(), body);
    await Promise.all(waiting);
    assert.equal(read, 0);
    // After them, whoever asks still gets what's kept, as it was, and the next gets what's built meanwhile.
    clock += 1;
    const stale = await get(e, "/whoami", "application/json");
    assert.deepEqual(
      [stale.headers.get("cache-control"), stale.headers.get("x-kept-at"), stale.headers.get("x-good-for"), await stale.text()],
      ["public, max-age=300", null, null, body],
    );
    await Promise.all(waiting);
    await Promise.all(waiting); // what was built is kept
    assert.equal(read, 1);
    const next = (await (await get(e, "/whoami", "application/json")).json()) as { multiDownloads: number };
    assert.equal(next.multiDownloads, 7);
    assert.equal(read, 1);
    // So does one who asks whether it has changed: it's told it hasn't, and it's built again whole.
    clock += 300_000;
    e.kv.set("live", JSON.stringify({ gems: { multi_json: 8, multi_xml: 0 } }));
    const unchanged = await worker.fetch(
      new Request("https://sferik.net/whoami", { headers: { accept: "application/json", "if-none-match": stale.headers.get("etag")! } }),
      e,
      CTX,
    );
    assert.deepEqual([unchanged.status, unchanged.headers.get("cache-control")], [304, "public, max-age=300"]);
    await Promise.all(waiting);
    await Promise.all(waiting);
    assert.equal(((await (await get(e, "/whoami", "application/json")).json()) as { multiDownloads: number }).multiDownloads, 8);
    // One that says not to be answered from a cache isn't answered with what's no longer good: it's built
    // now, and kept. While what's kept is good, that's its answer all the same, and nothing is built.
    const fresh = (headers: Record<string, string> = {}, method = "GET") =>
      worker.fetch(
        new Request("https://sferik.net/whoami", { method, headers: { accept: "application/json", "cache-control": "no-cache", ...headers } }),
        e,
        CTX,
      );
    const downloads = async (response: Response) => ((await response.json()) as { multiDownloads: number }).multiDownloads;
    assert.equal(await downloads(await fresh()), 8);
    e.kv.set("live", JSON.stringify({ gems: { multi_json: 9, multi_xml: 0 } }));
    assert.equal(await downloads(await fresh()), 8);
    clock += 300_000;
    read = 0;
    const now = await fresh({ "Cache-Control": "max-age=0, No-Cache" });
    assert.deepEqual([now.headers.get("cache-control"), await downloads(now), read], ["public, max-age=300", 9, 1]);
    await Promise.all(waiting);
    assert.equal(await downloads(await get(e, "/whoami", "application/json")), 9);
    assert.equal(read, 1);
    // One that asks whether what it has is still so is told of what's so now, and so is a HEAD, while it's built
    // again whole for the next to ask.
    for (const [headers, method, status] of [
      [{ "if-none-match": now.headers.get("etag")! }, "GET", 304],
      [{ "if-none-match": '"another"' }, "GET", 200],
      [{}, "HEAD", 200],
    ] as const) {
      clock += 300_000;
      read = 0;
      const told = await fresh(headers, method);
      assert.deepEqual(
        [told.status, method === "HEAD" || status === 304 ? await told.text() : await downloads(told)],
        [status, status === 200 && method === "GET" ? 9 : ""],
      );
      await Promise.all(waiting);
      await Promise.all(waiting);
      assert.equal(read, 2, `${method} ${status}`); // once for it, and once for the next
    }
    // What changes only with a deploy is kept an hour past its own hour.
    await get(e, "/talks", "application/json");
    await Promise.all(waiting);
    assert.equal([...kept.values()].at(-1)!.headers.get("cache-control"), "public, max-age=7200");
    // Who's on is good for a few seconds, and kept no longer: the cache drops it then, and nothing here builds it again.
    await post(e, "/who?token=0123456789abcdef&page=/");
    const on = await get(e, "/who", "application/json");
    assert.deepEqual(((await on.json()) as { users: unknown[] }).users.length, 1);
    await Promise.all(waiting);
    const who = [...kept.values()].at(-1)!;
    assert.deepEqual([who.headers.get("cache-control"), who.headers.get("x-kept-at"), who.headers.get("x-good-for")], ["public, max-age=5", null, null]);
    clock += 3_600_000;
    const mbp = e.MBP.get;
    e.MBP.get = () => assert.fail("the Durable Object was asked");
    await get(e, "/who", "application/json");
    await Promise.all(waiting);
    await Promise.all(waiting);
    e.MBP.get = mbp;
  });

  test("takes write's Idempotency-Key, so a message sent again isn't emailed twice, unless it didn't go through", async (t) => {
    stub(t, console, "error", () => {});
    let clock = Date.UTC(2026, 9, 7);
    stub(t, Date, "now", () => clock);
    const e = env();
    const key = { "idempotency-key": "0f8fad5b-d9cb-469f-a165-70867728950e", accept: "application/json" };
    const send = e.MAIL.send;
    e.MAIL.send = () => Promise.reject(new Error("no route"));
    const lost = await post(e, "/write", "hello", "192.0.2.1", key);
    assert.deepEqual([lost.status, await lost.json()], [502, { error: "the message didn't go through; try again later", code: "undelivered" }]);
    e.MAIL.send = send;
    // Sent again within the minute, it's told again that it didn't go through. After it, the key is forgotten, so
    // it's sent.
    const early = await post(e, "/write", "hello", "192.0.2.1", key);
    assert.deepEqual([early.status, early.headers.get("retry-after"), e.sent.length], [502, "60", 0]);
    clock += 60e3;
    assert.deepEqual([(await post(e, "/write", "hello", "192.0.2.1", key)).status, e.sent.length], [202, 1]);
    assert.deepEqual([(await post(e, "/write", "hello", "192.0.2.3", key)).status, e.sent.length], [202, 1]);
  });

  test("a request doesn't change the bundled data another request sees", async () => {
    const e = env();
    const first = await (await get(e, "/whoami", "application/json")).text();
    assert.equal(await (await get(e, "/whoami", "application/json")).text(), first);
  });
});
