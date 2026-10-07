/*
 * sferik.net on Cloudflare Workers
 *
 * The same app as the Node server (src/server.ts), with these differences:
 *
 *   data/*.json   bundled into the Worker
 *   public/       served from Workers static assets
 *   live data     kept in KV by a cron trigger, so requests read it rather
 *                 than waiting on RubyGems and GitHub
 *   who's on      a Durable Object, mbp, so every tab sees the same list
 *   rations       rate limits by address, on check-ins and write's messages
 *   the API       kept in the cache at each Cloudflare location, for as long
 *                 as each response says it's good for
 *   the pages     kept there too, for a minute, though browsers still check
 *                 for a new one on every load
 *   write         emailed, through Email Routing
 *
 * Deploy with `bun run deploy`; see the README for the one-time setup.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { EmailMessage } from "cloudflare:email";
import { DurableObject } from "cloudflare:workers";
import { createApp, createHost, letter, type Files, type Host, type HostStorage, type Letter, type Limit, type Store } from "./server.ts";
import type { Page } from "./types.js";
import contributions from "../data/contributions.json" with { type: "json" };
import dependency from "../data/dependency.json" with { type: "json" };
import name from "../data/name.json" with { type: "json" };
import profile from "../data/profile.json" with { type: "json" };
import projects from "../data/projects.json" with { type: "json" };
import resume from "../data/resume.json" with { type: "json" };
import talks from "../data/talks.json" with { type: "json" };
import whoami from "../data/whoami.json" with { type: "json" };

// The parts of the Workers runtime this file uses.
export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  LIVE: { get(key: string, type: "json"): Promise<unknown>; put(key: string, value: string): Promise<void> };
  MBP: { idFromName(name: string): unknown; get(id: unknown): Host };
  MAIL: { send(message: EmailMessage): Promise<void> };
  // Rate limits by address (wrangler.jsonc): check-ins, and write's messages.
  CHECK_INS: RateLimit;
  WRITES: RateLimit;
  GITHUB_TOKEN?: string;
  // Set by the deploy (wrangler deploy --var).
  COMMIT?: string;
  DEPLOYED?: string;
}

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
const allows =
  (ration: RateLimit): Limit =>
  async (address) =>
    (await ration.limit({ key: address })).success;

type App = ReturnType<typeof createApp>;

const DATA: Record<string, unknown> = { contributions, dependency, name, profile, projects, resume, talks, whoami };

// Copies, since the bundled objects outlive a request and the app may change what it reads.
const files = (env: Env): Files => ({
  data: async (file) => structuredClone(DATA[file]),
  async asset(file) {
    const res = await env.ASSETS.fetch(new Request(`https://assets.local/${file}`));
    return res.ok ? { body: new Uint8Array(await res.arrayBuffer()) } : null;
  },
});

// Every live value in one KV entry: requests read it once, and a refresh
// writes it once, which keeps well inside KV's free limits. What's saved is
// what was loaded or asked for since the entry was read: a refresh asks for
// the old value of anything it couldn't load, so that's kept, and a value
// nothing asks for any more (one an earlier version kept) is left behind.
const LIVE_KEY = "live";
export function kvStore(kv: Env["LIVE"]): Store & { save(): Promise<void> } {
  let values: Promise<Record<string, unknown>> | undefined;
  const load = () => (values ??= kv.get(LIVE_KEY, "json").then((v) => (v ?? {}) as Record<string, unknown>));
  const used = new Set<string>();
  return {
    async get(key) {
      used.add(key);
      return (await load())[key];
    },
    async put(key, value) {
      used.add(key);
      (await load())[key] = value;
    },
    async save() {
      const all = await load();
      await kv.put(LIVE_KEY, JSON.stringify(Object.fromEntries([...used].filter((key) => key in all).map((key) => [key, all[key]]))));
    },
  };
}

// The computer everyone's logged in to (see createHost), as a Durable
// Object: there's one, so every tab sees the same list, and it keeps it in
// its storage.
export class Mbp extends DurableObject<Env> {
  #host = createHost(this.ctx.storage as HostStorage, Date.now, allows(this.env.WRITES));
  beat(token: string, page: Page) {
    return this.#host.beat(token, page);
  }
  who() {
    return this.#host.who();
  }
  mail(ip: string, key?: string) {
    return this.#host.mail(ip, key);
  }
  unsent(key?: string) {
    return this.#host.unsent(key);
  }
}

// write's messages go to the address on the site, the one Email Routing has verified.
const FROM = "write@sferik.net";
const mailer = (env: Env) => async (l: Letter) =>
  env.MAIL.send(new EmailMessage(FROM, profile.email, letter(l, { from: FROM, to: profile.email, date: new Date(), id: crypto.randomUUID() })));

// Run the app's Node-style handler on a Fetch API request. It only reads the
// method, URL, a few headers (Accept, If-None-Match, Idempotency-Key, and for
// a POST where it's from), the body, and the visitor's address, and answers with one writeHead and
// one end.
export async function serve(app: App, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const req = {
    method: request.method,
    url: url.pathname + url.search,
    headers: {
      ...Object.fromEntries(
        ["accept", "if-none-match", "idempotency-key", "sec-fetch-site", "origin"].map((name) => [name, request.headers.get(name) ?? undefined]),
      ),
      host: url.host,
    },
    socket: { remoteAddress: request.headers.get("cf-connecting-ip") },
    // The body as it arrives, so the app can stop keeping one that's too
    // long (readBody) without all of it having been read into memory first.
    async *[Symbol.asyncIterator]() {
      if (request.body) yield* request.body as unknown as AsyncIterable<Uint8Array>;
    },
  };
  let status = 500;
  let headers: Record<string, string> = {};
  let body: string | Uint8Array | undefined;
  const res = {
    writeHead(code: number, fields: Record<string, string>) {
      status = code;
      headers = fields;
    },
    end(chunk?: string | Uint8Array) {
      body = chunk;
    },
  };
  await app(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return new Response(status === 204 || status === 304 ? null : (body as BodyInit | undefined), { status, headers });
}

// The pages whose JSON includes every live value: /contributions has the graph
// and the latest push, and /src has downloads (which /whoami uses too) and stars.
const LIVE_PATHS = ["/contributions", "/src"];

// The cache at each of Cloudflare's locations, where the Worker runs. What a
// resource's JSON, text, and the like say changes only when the live data is
// refreshed, and they say how long they're good for (Cache-Control: public,
// max-age), so for that long they're kept here, and answered without reading
// KV or building them again. Who's on isn't (no-store).
//
// A page tells browsers to check for a new one on every load (no-cache), and
// building one is the most work the Worker does: every resource it shows, as
// JSON and as text. So a page is kept as well, for a minute, under a
// Cache-Control the cache will take, with the page's own beside it, which is
// put back before it's sent. A deploy starts a new set of entries (the commit
// is in each one's key), so a page from before it never loads scripts from after.
interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}
const PAGES_FOR = 60; // seconds
const OWN = "x-own-cache-control";
const isPage = (response: Response) => response.headers.get("cache-control") === "no-cache" && /^text\/html\b/.test(response.headers.get("content-type")!);
function toKeep(response: Response): Response {
  const copy = new Response(response.body, response);
  copy.headers.set(OWN, "no-cache");
  copy.headers.set("cache-control", `public, max-age=${PAGES_FOR}`);
  return copy;
}
function toSend(kept: Response): Response {
  const own = kept.headers.get(OWN);
  if (!own) return kept;
  const response = new Response(kept.body, kept);
  response.headers.set("cache-control", own);
  response.headers.delete(OWN);
  return response;
}
const edge = () => (globalThis as { caches?: { default?: EdgeCache } }).caches?.default;
export interface Context {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    // One entry for each way of asking: the same URL is JSON to one Accept
    // header and text to another. Asked with If-None-Match, the cache answers
    // 304 Not Modified itself.
    const cache = request.method === "GET" ? edge() : undefined;
    const url = new URL(request.url);
    const key = `${url.origin}${url.pathname}?${new URLSearchParams({ search: url.search, accept: request.headers.get("accept") ?? "", commit: env.COMMIT ?? "" })}`;
    const tag = request.headers.get("if-none-match");
    const kept = await cache?.match(new Request(key, { headers: tag ? { "if-none-match": tag } : {} }));
    if (kept) return toSend(kept);
    const app = createApp({
      files: files(env),
      store: kvStore(env.LIVE),
      token: env.GITHUB_TOKEN,
      version: { commit: env.COMMIT, deployed: env.DEPLOYED },
      host: env.MBP.get(env.MBP.idFromName("mbp")),
      limit: allows(env.CHECK_INS),
      mail: mailer(env),
    });
    const response = await serve(app, request);
    if (cache && response.status === 200) {
      if (isPage(response)) ctx.waitUntil(cache.put(new Request(key), toKeep(response.clone())));
      else if (/^public, max-age=[1-9]/.test(response.headers.get("cache-control") ?? "")) ctx.waitUntil(cache.put(new Request(key), response.clone()));
    }
    return response;
  },

  // The cron trigger (wrangler.jsonc): fetch every live value and save them.
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const store = kvStore(env.LIVE);
    const app = createApp({ files: files(env), store, refresh: true, token: env.GITHUB_TOKEN });
    for (const path of LIVE_PATHS) await serve(app, new Request(`https://sferik.net${path}`, { headers: { accept: "application/json" } }));
    await store.save();
  },
};
