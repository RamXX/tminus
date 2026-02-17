/**
 * Production Durable Object wrappers for UserGraphDO and AccountDO.
 *
 * The core DO classes in @tminus/do-user-graph and @tminus/do-account are
 * designed as testable, framework-agnostic classes that accept a
 * SqlStorageLike interface and don't extend the Cloudflare DurableObject
 * base class.
 *
 * These wrappers adapt them to the Cloudflare Workers runtime:
 * - Extend DurableObject from "cloudflare:workers" (required by workerd)
 * - Extract ctx.storage.sql and env bindings in the constructor
 * - Delegate fetch() to the inner class's handleFetch()
 *
 * Why: The Cloudflare runtime constructs DO classes with (ctx, env), not
 * (sql, writeQueue). Without these wrappers, the inner class receives
 * wrong arguments and fails when trying to call sql.exec().
 */

import { DurableObject } from "cloudflare:workers";
import { UserGraphDO as UserGraphDOCore } from "@tminus/do-user-graph";
import { AccountDO as AccountDOCore } from "@tminus/do-account";
import type { OAuthCredentials } from "@tminus/do-account";
import type { SqlStorageLike } from "@tminus/shared";

/**
 * Production wrapper for UserGraphDO.
 *
 * Extracts ctx.storage.sql (SqlStorage) and env.WRITE_QUEUE (Queue)
 * and passes them to the core UserGraphDO class.
 */
export class UserGraphDO extends DurableObject<Env> {
  private readonly inner: UserGraphDOCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Cast SqlStorage to SqlStorageLike: structurally compatible at runtime,
    // but TypeScript's generic variance makes them nominally incompatible.
    const sql = ctx.storage.sql as unknown as SqlStorageLike;
    this.inner = new UserGraphDOCore(sql, env.WRITE_QUEUE);
  }

  async fetch(request: Request): Promise<Response> {
    return this.inner.handleFetch(request);
  }
}

/**
 * Production wrapper for AccountDO.
 *
 * Extracts ctx.storage.sql (SqlStorage), env.MASTER_KEY (string),
 * OAuth client credentials, and uses globalThis.fetch for HTTP calls.
 */
export class AccountDO extends DurableObject<Env> {
  private readonly inner: AccountDOCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Cast SqlStorage to SqlStorageLike: structurally compatible at runtime.
    const sql = ctx.storage.sql as unknown as SqlStorageLike;
    const oauthCredentials: OAuthCredentials = {
      googleClientId: env.GOOGLE_CLIENT_ID ?? "",
      googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
      msClientId: env.MS_CLIENT_ID ?? "",
      msClientSecret: env.MS_CLIENT_SECRET ?? "",
    };
    this.inner = new AccountDOCore(
      sql,
      env.MASTER_KEY ?? "",
      globalThis.fetch.bind(globalThis),
      undefined, // provider -- determined per-account, not per-worker
      oauthCredentials,
    );
  }

  async fetch(request: Request): Promise<Response> {
    return this.inner.handleFetch(request);
  }
}
