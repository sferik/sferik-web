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
 *   write         emailed, through Email Routing
 *
 * Deploy with `bun run deploy`; see the README for the one-time setup.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { EmailMessage } from "cloudflare:email";
import { DurableObject } from "cloudflare:workers";
import { createApp, createHost, letter, type Files, type Host, type HostStorage, type Letter, type Store } from "./server.ts";
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
  GITHUB_TOKEN?: string;
  // Set by the deploy (wrangler deploy --var).
  COMMIT?: string;
  DEPLOYED?: string;
}

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
// writes it once, which keeps well inside KV's free limits.
const LIVE_KEY = "live";
export function kvStore(kv: Env["LIVE"]): Store & { save(): Promise<void> } {
  let values: Promise<Record<string, unknown>> | undefined;
  const load = () => (values ??= kv.get(LIVE_KEY, "json").then((v) => (v ?? {}) as Record<string, unknown>));
  return {
    get: async (key) => (await load())[key],
    async put(key, value) {
      (await load())[key] = value;
    },
    save: async () => kv.put(LIVE_KEY, JSON.stringify(await load())),
  };
}

// The computer everyone's logged in to (see createHost), as a Durable
// Object: there's one, so every tab sees the same list, and it keeps it in
// its storage.
export class Mbp extends DurableObject<Env> {
  #host = createHost(this.ctx.storage as HostStorage);
  beat(token: string, page: Page) {
    return this.#host.beat(token, page);
  }
  who() {
    return this.#host.who();
  }
  mail(ip: string, key?: string) {
    return this.#host.mail(ip, key);
  }
  unsent(key: string) {
    return this.#host.unsent(key);
  }
}

// write's messages go to the address on the site, the one Email Routing has verified.
const FROM = "write@sferik.net";
const mailer = (env: Env) => async (l: Letter) =>
  env.MAIL.send(new EmailMessage(FROM, profile.email, letter(l, { from: FROM, to: profile.email, date: new Date(), id: crypto.randomUUID() })));

// Run the app's Node-style handler on a Fetch API request. It only reads the
// method, URL, Accept, If-None-Match and Idempotency-Key headers, the body (as
// one chunk), and the visitor's address, and answers with one writeHead and
// one end.
export async function serve(app: App, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sent = new Uint8Array(await request.arrayBuffer());
  const req = {
    method: request.method,
    url: url.pathname + url.search,
    headers: Object.fromEntries(["accept", "if-none-match", "idempotency-key"].map((name) => [name, request.headers.get(name) ?? undefined])),
    socket: { remoteAddress: request.headers.get("cf-connecting-ip") },
    async *[Symbol.asyncIterator]() {
      yield sent;
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

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const app = createApp({
      files: files(env),
      store: kvStore(env.LIVE),
      token: env.GITHUB_TOKEN,
      version: { commit: env.COMMIT, deployed: env.DEPLOYED },
      host: env.MBP.get(env.MBP.idFromName("mbp")),
      mail: mailer(env),
    });
    return serve(app, request);
  },

  // The cron trigger (wrangler.jsonc): fetch every live value and save them.
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const store = kvStore(env.LIVE);
    const app = createApp({ files: files(env), store, refresh: true, token: env.GITHUB_TOKEN });
    for (const path of LIVE_PATHS) await serve(app, new Request(`https://sferik.net${path}`, { headers: { accept: "application/json" } }));
    await store.save();
  },
};
