// The parts of the Workers runtime's own modules that src/worker.ts uses.
// (The tests stand in for them: tests/support/cloudflare.ts.)
declare module "cloudflare:email" {
  export class EmailMessage {
    constructor(from: string, to: string, raw: string);
    readonly from: string;
    readonly to: string;
  }
}

declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    constructor(ctx: { storage: unknown }, env: Env);
    protected ctx: { storage: unknown };
    protected env: Env;
  }
}
