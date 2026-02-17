/**
 * Vitest stub for the "cloudflare:workers" runtime module.
 *
 * The Cloudflare Workers runtime provides built-in modules under the
 * "cloudflare:" scheme. These are unavailable in Node/vitest. This stub
 * provides the minimal surface area needed so that transitive imports
 * (e.g. workflow-wrapper.ts -> cloudflare:workers) resolve without error.
 *
 * Only production code runs against the real module; unit tests never
 * exercise WorkflowEntrypoint directly.
 */

/**
 * Stub for WorkflowEntrypoint.
 *
 * The real class is constructed by the Cloudflare Workflows runtime with
 * (ctx, env). Our wrapper only accesses `this.env`, so we expose that.
 */
export class WorkflowEntrypoint<TEnv = unknown, TParams = unknown> {
  env: TEnv;

  constructor(ctx?: unknown, env?: TEnv) {
    this.env = env as TEnv;
  }

  // Subclasses override run(); stub is a no-op.
  async run(
    _event: { payload: TParams; timestamp: Date; instanceId: string },
    _step: { do: <T>(name: string, fn: () => Promise<T>) => Promise<T> },
  ): Promise<void> {
    // no-op in tests
  }
}

/**
 * Stub for DurableObject.
 *
 * Some wrappers extend DurableObject from cloudflare:workers.
 * Providing a minimal stub prevents resolution errors.
 */
export class DurableObject<TEnv = unknown> {
  ctx: unknown;
  env: TEnv;

  constructor(ctx?: unknown, env?: TEnv) {
    this.ctx = ctx;
    this.env = env as TEnv;
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response("stub", { status: 501 });
  }
}
