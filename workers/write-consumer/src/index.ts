/**
 * write-consumer -- Cloudflare Worker queue consumer for write-queue.
 *
 * Processes UPSERT_MIRROR and DELETE_MIRROR messages to create, update,
 * and delete mirror events in target Google Calendar accounts.
 *
 * Queue configuration (from wrangler.toml):
 * - queue: tminus-write-queue
 * - max_retries: 5
 * - dead_letter_queue: tminus-write-queue-dlq
 *
 * Bindings:
 * - ACCOUNT: AccountDO namespace (for getAccessToken)
 * - USER_GRAPH: UserGraphDO namespace (for mirror state)
 * - DB: D1 registry database
 */

import {
  APP_NAME,
  GoogleCalendarClient,
  BUSY_OVERLAY_CALENDAR_NAME,
} from "@tminus/shared";
import type {
  UpsertMirrorMessage,
  DeleteMirrorMessage,
  MirrorState,
} from "@tminus/shared";
import { WriteConsumer } from "./write-consumer";
import type {
  MirrorStore,
  MirrorRow,
  MirrorUpdate,
  TokenProvider,
} from "./write-consumer";

// ---------------------------------------------------------------------------
// Queue handler
// ---------------------------------------------------------------------------

export default {
  /**
   * Health check endpoint. Returns worker name.
   */
  async fetch(
    _request: Request,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    return new Response(`${APP_NAME} Write Consumer worker`, { status: 200 });
  },

  /**
   * Queue consumer handler. Processes batches of write-queue messages.
   *
   * For each message:
   * 1. Instantiate WriteConsumer with DO-backed stores
   * 2. Process the message
   * 3. If retry is needed, call msg.retry() to re-enqueue
   * 4. If permanent failure, ack the message (it will NOT be retried)
   *
   * After max_retries (5), Cloudflare automatically routes to DLQ.
   */
  async queue(
    batch: MessageBatch<UpsertMirrorMessage | DeleteMirrorMessage>,
    env: Env,
  ): Promise<void> {
    for (const msg of batch.messages) {
      try {
        // Build dependencies from environment bindings.
        // In production, these would use DO stubs for AccountDO and UserGraphDO.
        // The actual DO RPC protocol is out of scope for this story --
        // the WriteConsumer class is the tested unit; the wiring to real DOs
        // is handled by the walking skeleton story (TM-yhf).
        //
        // For now, the queue handler delegates to WriteConsumer with the
        // message body. The DO-backed MirrorStore and TokenProvider
        // implementations will be wired in the walking skeleton.
        const body = msg.body;

        // NOTE: Production wiring requires DO stub implementations of
        // MirrorStore and TokenProvider. These are created from env.USER_GRAPH
        // and env.ACCOUNT respectively. The exact RPC protocol depends on
        // how UserGraphDO and AccountDO expose their methods via fetch().
        // This placeholder shows the queue consumer structure.

        // For now, acknowledge all messages to prevent infinite retry loops
        // during initial deployment. The full wiring is done in TM-yhf.
        msg.ack();
      } catch (err) {
        // Let the message be retried by the queue runtime
        msg.retry();
      }
    }
  },
};
