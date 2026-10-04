/*
 * sferik.com on Cloudflare Workers
 *
 * The same app as the Node server (src/server.ts), with three differences:
 *
 *   data/*.json   bundled into the Worker
 *   public/       served from Workers static assets
 *   live data     kept in KV by a cron trigger, so requests read it rather
 *                 than waiting on RubyGems and GitHub
 *
 * Deploy with `bun run deploy`; see the README for the one-time setup.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp, type Files, type Store } from "./server.ts";
import contributions from "../data/contributions.json" with { type: "json" };
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
  GITHUB_TOKEN?: string;
}

type App = ReturnType<typeof createApp>;

const DATA: Record<string, unknown> = { contributions, name, profile, projects, resume, talks, whoami };

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

// Run the app's Node-style handler on a Fetch API request. It only reads the
// method, URL, and Accept header, and answers with one writeHead and one end.
export async function serve(app: App, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const req = { method: request.method, url: url.pathname + url.search, headers: { accept: request.headers.get("accept") ?? undefined } };
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
  return new Response(status === 204 ? null : (body as BodyInit | undefined), { status, headers });
}

// The pages whose JSON includes every live value: /contributions has the graph
// and the latest push, and /src has downloads (which /whoami uses too) and stars.
const LIVE_PATHS = ["/contributions", "/src"];

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const app = createApp({ files: files(env), store: kvStore(env.LIVE), token: env.GITHUB_TOKEN });
    return serve(app, request);
  },

  // The cron trigger (wrangler.jsonc): fetch every live value and save them.
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const store = kvStore(env.LIVE);
    const app = createApp({ files: files(env), store, refresh: true, token: env.GITHUB_TOKEN });
    for (const path of LIVE_PATHS) await serve(app, new Request(`https://sferik.com${path}`, { headers: { accept: "application/json" } }));
    await store.save();
  },
};
