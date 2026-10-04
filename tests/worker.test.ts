// Tests for src/worker.ts, the Cloudflare Workers entry point, with stand-ins
// for its static assets and KV bindings and for RubyGems and GitHub. Run with
// `bun run test:server`.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import worker, { type Env } from "../src/worker.ts";

const PUBLIC = path.join(import.meta.dirname, "..", "public");

// The bindings: ASSETS serves public/ from disk, and LIVE is KV in a Map.
function env(): Env & { kv: Map<string, string> } {
  const kv = new Map<string, string>();
  return {
    kv,
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
  worker.fetch(new Request(`https://sferik.com${url}`, { method, headers: accept ? { accept } : {} }), e);
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
    assert.equal((await json(e, "/src")).live, false);

    const fetch = t.mock.method(globalThis, "fetch", upstream);
    await worker.scheduled(undefined, e);
    assert.ok(fetch.mock.callCount() > 3);
    assert.equal(e.kv.size, 1); // every value in one entry, written once

    const src = (await json(e, "/src")) as { live: boolean; total: { downloads: number } };
    assert.deepEqual([src.live, src.total.downloads], [true, 7]);
    const graph = (await json(e, "/contributions")) as { live: boolean; total: number; lastPush: { sha: string } };
    assert.deepEqual([graph.live, graph.total, graph.lastPush.sha], [true, 3, "abc1234"]);
    assert.equal((await json(e, "/whoami")).multiDownloads, 7);
  });

  test("a request doesn't change the bundled data another request sees", async () => {
    const e = env();
    const first = await (await get(e, "/whoami", "application/json")).text();
    assert.equal(await (await get(e, "/whoami", "application/json")).text(), first);
  });
});
