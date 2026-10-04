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
type Sent = { from: string; to: string; raw: string };
function env(): Env & { kv: Map<string, string>; sent: Sent[] } {
  const kv = new Map<string, string>();
  const sent: Sent[] = [];
  const mbp = new Mbp({ storage: memoryStorage() }, {} as Env);
  return {
    kv,
    sent,
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

const get = (e: Env, url: string, accept?: string, method = "GET") =>
  worker.fetch(new Request(`https://sferik.net${url}`, { method, headers: accept ? { accept } : {} }), e);
const post = (e: Env, url: string, body?: string, ip = "192.0.2.1", headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://sferik.net${url}`, { method: "POST", body, headers: { "cf-connecting-ip": ip, ...headers } }), e);
const json = async (e: Env, url: string) => (await get(e, url, "application/json")).json() as Promise<Record<string, unknown>>;

// RubyGems and GitHub, for the scheduled refresh.
const UPSTREAM: Record<string, unknown> = {
  "https://rubygems.org/api/v1/owners/sferik/gems.json": [
    { name: "multi_json", downloads: 7 },
    { name: "multi_xml", downloads: 0 },
  ],
  "https://github-contributions-api.jogruber.de/v4/sferik?y=last": { contributions: [{ date: "2026-10-01", count: 3, level: 2 }] },
  "https://api.github.com/users/sferik/events/public?per_page=30": [
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
    const again = await worker.fetch(new Request("https://sferik.net/whoami", { headers: { accept: "application/json", "if-none-match": tag } }), e);
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

  test("takes write's Idempotency-Key, so a message sent again isn't emailed twice, unless it didn't go through", async (t) => {
    stub(t, console, "error", () => {});
    const e = env();
    const key = { "idempotency-key": "0f8fad5b-d9cb-469f-a165-70867728950e", accept: "application/json" };
    const send = e.MAIL.send;
    e.MAIL.send = () => Promise.reject(new Error("no route"));
    const lost = await post(e, "/write", "hello", "192.0.2.1", key);
    assert.deepEqual([lost.status, await lost.json()], [502, { error: "the message didn't go through; try again later", code: "undelivered" }]);
    e.MAIL.send = send;
    // From another address, since this one must wait a minute: the key was forgotten, so it's sent.
    assert.deepEqual([(await post(e, "/write", "hello", "192.0.2.2", key)).status, e.sent.length], [202, 1]);
    assert.deepEqual([(await post(e, "/write", "hello", "192.0.2.3", key)).status, e.sent.length], [202, 1]);
  });

  test("a request doesn't change the bundled data another request sees", async () => {
    const e = env();
    const first = await (await get(e, "/whoami", "application/json")).text();
    assert.equal(await (await get(e, "/whoami", "application/json")).text(), first);
  });
});
