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
 *                 as each response says it's good for, and for an hour more,
 *                 to be sent at once while it's built again for the next
 *   the scripts   a deploy's own, at /v/<commit>/, kept there too
 *   the pages     kept there too, and sent at once while a new one is built
 *                 for the next reader, though browsers still check for a new
 *                 one on every load
 *   write         emailed, through Email Routing
 *   compression   Cloudflare's, but for the types it leaves as they are (the
 *                 API's description, the feed, the PDF), which are gzipped here
 *
 * Deploy with `bun run deploy`; see the README for the one-time setup.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { EmailMessage } from "cloudflare:email";
import { DurableObject } from "cloudflare:workers";
import { asksFor, createApp, createHost, letter, type Files, type Host, type HostStorage, type Letter, type Limit, type Store } from "./server.ts";
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
  delivered(key: string) {
    return this.#host.delivered(key);
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
// KV or building them again. So is who's on, for the few seconds it says, so
// that asking over and over isn't a request to the Durable Object each time.
//
// A page tells browsers to check for a new one on every load (no-cache), and
// building one is the most work the Worker does: every resource it shows, as
// JSON and as text. So a page is kept as well, under a Cache-Control the cache
// will take. A deploy starts a new set of entries (the commit is in each one's
// key), so a page from before it never loads scripts from after.
//
// A page is good for a minute, but kept for an hour more: on a site this
// quiet, most readers come more than a minute after the last one, and each
// would wait for a page to be built. One that's older than a minute is sent as
// it is, at once, and a new one is built for the next reader after that's gone.
// So a page's numbers are from the last time it was asked for, within the hour.
// While one is being built, that's kept too, for half a minute, so the readers
// who come before it's done don't each have one built as well.
//
// What the API says is kept the same way, for an hour past what it says it's
// good for, since most who ask for it come after that as well. Sent when it's
// no longer good, it says how old it is (Age, which the cache counts), and
// that's more than it's good for: so whoever keeps what they're told asks
// again the next time, and gets the one that was built meanwhile. Only what's
// good for less than a minute isn't kept past it: who's on, which would be a
// list of who was.
//
// What wasn't found is kept for a minute too, since most of what asks for
// what isn't here is a script trying every door (/wp-login.php), and so is
// what's asked of HEAD, from what GET kept.
//
// What's kept has its own Cache-Control beside it, which is put back before
// it's sent. For a page that's the no-cache the cache wouldn't take, and for
// what wasn't found it's none. For the rest it's the one they were kept under,
// which the cache doesn't hand back as it was: Cloudflare gives what it
// answers the zone's Browser Cache TTL (four hours, unless it's set to respect
// the headers there are), so who's on, good for five seconds, told whoever
// asked to keep it for four hours.
interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}
const PAGES_FOR = 60; // seconds a page is good for
const KEPT_PAST = 3600; // seconds a response is kept after that, to be sent while the next is built
const SOON = 60; // seconds: what's good for less is never sent once it isn't
const BUILDING_FOR = 30; // seconds that a page being built is left to it, before another is
const MISSING_FOR = 60; // seconds
const OWN = "x-own-cache-control";
const NONE = "none"; // for a response with no Cache-Control of its own
const KEPT_AT = "x-kept-at"; // when a response was kept, in milliseconds, if it's to be sent past what it's good for
const GOOD_FOR = "x-good-for"; // and the seconds it's good for
const isPage = (response: Response) => response.headers.get("cache-control") === "no-cache" && /^text\/html\b/.test(response.headers.get("content-type")!);
const keepable = (response: Response) =>
  response.status === 404 || (response.status === 200 && (isPage(response) || /^public, max-age=[1-9]/.test(String(response.headers.get("cache-control")))));
function toKeep(response: Response, now: number): Response {
  const copy = new Response(response.body, response);
  copy.headers.set(OWN, response.headers.get("cache-control") ?? NONE);
  if (response.status === 404) copy.headers.set("cache-control", `public, max-age=${MISSING_FOR}`);
  else {
    // A page's minute, or else the seconds the response says, which whatever else is kept does (keepable).
    const good = isPage(response) ? PAGES_FOR : Number(/max-age=(\d+)/.exec(response.headers.get("cache-control")!)![1]);
    if (good >= SOON) {
      copy.headers.set("cache-control", `public, max-age=${good + KEPT_PAST}`);
      copy.headers.set(KEPT_AT, String(now));
      copy.headers.set(GOOD_FOR, String(good));
    }
  }
  return copy;
}
function toSend(kept: Response, head: boolean): Response {
  const response = new Response(head ? null : kept.body, kept);
  const own = kept.headers.get(OWN)!;
  if (own === NONE) response.headers.delete("cache-control");
  else response.headers.set("cache-control", own);
  response.headers.delete(OWN);
  response.headers.delete(KEPT_AT);
  response.headers.delete(GOOD_FOR);
  return response;
}
// Whether what's kept is no longer good, to be built again. (What's never sent past what it's good for says
// neither when it was kept nor for how long, and isn't.)
const old = (kept: Response, now: number) => now - Number(kept.headers.get(KEPT_AT) ?? Infinity) >= Number(kept.headers.get(GOOD_FOR)) * 1000;
// What's kept to say a response is being built, and whether that still holds.
const building = (now: number) => new Response("building", { headers: { "cache-control": `public, max-age=${BUILDING_FOR}`, [KEPT_AT]: String(now) } });
const begun = (marker: Response | undefined, now: number) => marker !== undefined && now - Number(marker.headers.get(KEPT_AT)) < BUILDING_FOR * 1000;
// A query that changes nothing isn't another entry: /whoami?x=1 is /whoami,
// and without this each one made up would be built anew. Only WebFinger reads
// its query (the account asked about), and it's not at the top, like the
// resources are, so only a path that is has its query left out.
const TOP = /^\/[\w.-]*$/;
const edge = () => (globalThis as { caches?: { default?: EdgeCache } }).caches?.default;
export interface Context {
  waitUntil(promise: Promise<unknown>): void;
}

// What Cloudflare sends as it is, though it's text, or as good as: it
// compresses a list of types, and the API's description (58 kB of JSON, under
// a type of its own), the feed, the contact card, WebFinger's answer, and the
// resume as LaTeX and as a PDF (whose pages are plain text inside) aren't on
// it. Said to be gzip, a response is compressed by the runtime as it's sent.
// So that's said last, of a response on its way out, and what's kept is kept
// as it was: one kept as gzip would be compressed again. And it's said only
// to what takes gzip, which isn't what the request's Accept-Encoding says
// here (Cloudflare has put its own there) but what it said when it arrived:
// curl, which asks for no encoding unless it's told to, gets the PDF as it is.
// Compressed, a response isn't byte for byte the one its ETag names, so the
// tag is a weak one (W/), as Cloudflare makes it for what it compresses itself:
// asked for again with that, what hasn't changed is still a 304.
const UNCOMPRESSED = /^(?:application\/(?:openapi\+json|jrd\+json|atom\+xml|x-latex|pdf)|text\/vcard)\b/;
function compressed(response: Response, request: Request): Response {
  const plain = response.status !== 200 || !UNCOMPRESSED.test(response.headers.get("content-type")!);
  const takes = (request as { cf?: { clientAcceptEncoding?: string } }).cf?.clientAcceptEncoding ?? "";
  if (plain || !/\bgzip\b/.test(takes)) return response;
  const out = new Response(response.body, response);
  out.headers.set("content-encoding", "gzip");
  out.headers.set("etag", `W/${response.headers.get("etag")}`);
  out.headers.append("vary", "Accept-Encoding");
  return out;
}

// Answer a request from the cache, or else with the app.
async function respond(request: Request, env: Env, ctx: Context): Promise<Response> {
  // One entry for each thing asked for: the same URL is JSON to one Accept
  // header and text to another, but the same to every one that wants the
  // same formats as much (asksFor), as each browser's does for a page. Asked
  // with If-None-Match, the cache answers 304 Not Modified itself.
  const cache = request.method === "GET" || request.method === "HEAD" ? edge() : undefined;
  const url = new URL(request.url);
  const key = `${url.origin}${url.pathname}?${new URLSearchParams({ search: TOP.test(url.pathname) ? "" : url.search, accept: asksFor(request.headers.get("accept") ?? undefined), commit: env.COMMIT ?? "" })}`;
  const tag = request.headers.get("if-none-match");
  const kept = await cache?.match(new Request(key, { headers: tag ? { "if-none-match": tag } : {} }));
  // Answer a request with the app, and keep what a GET is told, if it's to be kept.
  const answer = async (asked: Request) => {
    const app = createApp({
      files: files(env),
      store: kvStore(env.LIVE),
      token: env.GITHUB_TOKEN,
      version: { commit: env.COMMIT, deployed: env.DEPLOYED },
      host: env.MBP.get(env.MBP.idFromName("mbp")),
      limit: allows(env.CHECK_INS),
      mail: mailer(env),
    });
    const response = await serve(app, asked);
    if (cache && asked.method === "GET" && keepable(response)) ctx.waitUntil(cache.put(new Request(key), toKeep(response.clone(), Date.now())));
    return response;
  };
  if (!kept) return answer(request);
  const now = Date.now();
  const marker = new Request(`${key}&building=1`);
  if (old(kept, now) && !begun(await cache!.match(marker), now)) {
    // The response again, whole, whatever this request was: a HEAD, or one with If-None-Match.
    const headers = new Headers(request.headers);
    headers.delete("if-none-match");
    ctx.waitUntil(cache!.put(marker, building(now)));
    ctx.waitUntil(answer(new Request(request.url, { headers })));
  }
  return toSend(kept, request.method === "HEAD");
}

export default {
  async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    return compressed(await respond(request, env, ctx), request);
  },

  // The cron trigger (wrangler.jsonc): fetch every live value and save them.
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const store = kvStore(env.LIVE);
    const app = createApp({ files: files(env), store, refresh: true, token: env.GITHUB_TOKEN });
    for (const path of LIVE_PATHS) await serve(app, new Request(`https://sferik.net${path}`, { headers: { accept: "application/json" } }));
    await store.save();
  },
};
