/**
 * Test-only Cloudflare Worker for real DO integration tests.
 *
 * Wraps UserGraphDO and AccountDO business logic classes with proper
 * DurableObject subclasses so Miniflare can instantiate them with real
 * SQLite storage. Exposes an HTTP RPC proxy so integration tests can
 * call any DO method directly.
 *
 * Routes:
 *   GET  /health                -> "OK" (test harness readiness check)
 *   POST /do/:namespace/:name/* -> proxy to DO via stub.fetch()
 *
 * :namespace is "USER_GRAPH" or "ACCOUNT"
 * :name is the DO name (used with idFromName)
 * Everything after :name becomes the DO-internal pathname
 *
 * NOT for production use.
 */

import { DurableObject } from "cloudflare:workers";
import {
  UserGraphDO as UserGraphDOLogic,
} from "../../durable-objects/user-graph/src/index";
import type { QueueLike } from "../../durable-objects/user-graph/src/index";
import {
  AccountDO as AccountDOLogic,
} from "../../durable-objects/account/src/index";
import type { SqlStorageLike, SqlStorageCursorLike } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Env binding types
// ---------------------------------------------------------------------------

interface Env {
  USER_GRAPH: DurableObjectNamespace;
  ACCOUNT: DurableObjectNamespace;
  SYNC_QUEUE: Queue;
  WRITE_QUEUE: Queue;
  WRITE_PRIORITY_QUEUE?: Queue;
  MASTER_KEY: string;
}

// ---------------------------------------------------------------------------
// SqlStorage adapter: wraps DurableObjectStorage.sql to match SqlStorageLike
// ---------------------------------------------------------------------------

function wrapSqlStorage(storage: DurableObjectStorage): SqlStorageLike {
  const sql = storage.sql;
  return {
    exec<T extends Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): SqlStorageCursorLike<T> {
      const cursor = sql.exec<T>(query, ...bindings);
      return {
        toArray(): T[] {
          return cursor.toArray();
        },
        one(): T {
          return cursor.one();
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// QueueLike adapter: wraps Cloudflare Queue to match QueueLike interface
// ---------------------------------------------------------------------------

function wrapQueue(queue: Queue): QueueLike {
  return {
    async send(message: unknown): Promise<void> {
      await queue.send(message);
    },
    async sendBatch(messages: { body: unknown }[]): Promise<void> {
      await queue.sendBatch(messages);
    },
  };
}

// ---------------------------------------------------------------------------
// AccountDO wrapper: proper DurableObject subclass
// ---------------------------------------------------------------------------

export class AccountDO extends DurableObject {
  private logic: AccountDOLogic;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = wrapSqlStorage(ctx.storage);
    this.logic = new AccountDOLogic(
      sql,
      env.MASTER_KEY,
      globalThis.fetch.bind(globalThis),
    );
  }

  async fetch(request: Request): Promise<Response> {
    return this.logic.handleFetch(request);
  }
}

// ---------------------------------------------------------------------------
// UserGraphDO wrapper: proper DurableObject subclass
// ---------------------------------------------------------------------------

export class UserGraphDO extends DurableObject {
  private logic: UserGraphDOLogic;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = wrapSqlStorage(ctx.storage);
    const queue = wrapQueue(env.WRITE_QUEUE);
    const priorityQueue = env.WRITE_PRIORITY_QUEUE
      ? wrapQueue(env.WRITE_PRIORITY_QUEUE)
      : undefined;
    this.logic = new UserGraphDOLogic(sql, queue, priorityQueue);
  }

  async fetch(request: Request): Promise<Response> {
    return this.logic.handleFetch(request);
  }
}

// ---------------------------------------------------------------------------
// Worker fetch handler: health check + DO RPC proxy
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Health check for test harness polling
    if (pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    // RPC proxy: POST /do/:namespace/:name/rest/of/path
    // Example: POST /do/ACCOUNT/acct_123/initialize
    const doMatch = pathname.match(
      /^\/do\/(USER_GRAPH|ACCOUNT)\/([^/]+)(\/.*)?$/,
    );
    if (doMatch && request.method === "POST") {
      const [, nsName, doName, doPath] = doMatch;
      const internalPath = doPath || "/";

      // Resolve the correct namespace
      const ns = nsName === "USER_GRAPH" ? env.USER_GRAPH : env.ACCOUNT;

      // Get DO stub by name
      const id = ns.idFromName(doName);
      const stub = ns.get(id);

      // Forward the request body to the DO
      const body = await request.text();
      const doResponse = await stub.fetch(
        new Request(`https://do.internal${internalPath}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body || undefined,
        }),
      );

      // Relay the DO response back to the test
      const responseBody = await doResponse.text();
      return new Response(responseBody, {
        status: doResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
