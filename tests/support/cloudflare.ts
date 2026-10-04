// Neither Node nor Bun has the cloudflare: modules, so for the server tests
// this stands in for the two that src/worker.ts imports: an EmailMessage that
// keeps what it's given, and a DurableObject base class that keeps its state.
// Node loads it with --import (bun run test:server); Bun, with the preload in
// bunfig.toml (bun test).
import * as nodeModule from "node:module"; // registerHooks, which only Node has

const STUB = `
export class EmailMessage { constructor(from, to, raw) { Object.assign(this, { from, to, raw }); } }
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
`;

type BunPlugins = { plugin(p: { name: string; setup(build: { module(name: string, load: () => { contents: string; loader: string }): void }): void }): void };
const bun = (globalThis as { Bun?: BunPlugins }).Bun;
if (bun)
  bun.plugin({
    name: "cloudflare",
    setup(build) {
      for (const name of ["cloudflare:email", "cloudflare:workers"]) build.module(name, () => ({ contents: STUB, loader: "js" }));
    },
  });
else
  nodeModule.registerHooks({
    resolve: (specifier, context, next) =>
      specifier.startsWith("cloudflare:") ? { url: `data:text/javascript,${encodeURIComponent(STUB)}`, shortCircuit: true } : next(specifier, context),
  });
