/**
 * DeletionWorkflow -- GDPR right-to-erasure cascading deletion.
 *
 * Executes 8-step cascading deletion across all data stores for a user:
 *   1. Delete canonical events from UserGraphDO SQLite
 *   2. Delete event mirrors from UserGraphDO SQLite
 *   3. Delete journal entries from UserGraphDO SQLite
 *   4. Delete relationship/ledger/milestone data from UserGraphDO SQLite
 *   5. Delete D1 registry rows (users, accounts for this user_id)
 *   6. Delete R2 audit objects (all objects with prefix user_id/)
 *   7. Enqueue provider-side mirror deletions to write-queue
 *   8. Update deletion_requests.status to 'completed' in D1
 *
 * Each step is idempotent: safe to retry on failure. DELETE on empty tables
 * is a no-op, R2 delete on missing keys is a no-op, D1 updates are
 * guarded by WHERE clauses.
 *
 * In production, each step maps to a Workflow step (ctx.step.do()) with
 * automatic retries. For testability, the logic is implemented as a plain
 * class with injectable dependencies.
 *
 * Architecture:
 * - No soft deletes (BR-7). Tombstone structural references only.
 * - Deletion certificate generation is handled by a separate story (TM-ito).
 */

// ---------------------------------------------------------------------------
// Env bindings (matches wrangler.toml bindings)
// ---------------------------------------------------------------------------

export interface DeletionEnv {
  USER_GRAPH: DurableObjectNamespace;
  DB: D1Database;
  R2_AUDIT: R2BucketLike;
  WRITE_QUEUE: QueueLike;
}

// ---------------------------------------------------------------------------
// Injectable interfaces for testability
// ---------------------------------------------------------------------------

/**
 * Minimal R2 bucket interface matching the Cloudflare R2Bucket API surface
 * we use. Allows test injection of a mock R2 bucket.
 */
export interface R2BucketLike {
  list(options?: { prefix?: string; cursor?: string }): Promise<R2ListResult>;
  delete(keys: string | string[]): Promise<void>;
}

/** R2 list result shape. */
export interface R2ListResult {
  objects: Array<{ key: string }>;
  truncated: boolean;
  cursor?: string;
}

/**
 * Minimal queue interface. Matches Cloudflare Queue API surface.
 */
export interface QueueLike {
  send(message: unknown): Promise<void>;
  sendBatch(messages: Array<{ body: unknown }>): Promise<void>;
}

// ---------------------------------------------------------------------------
// Workflow parameters
// ---------------------------------------------------------------------------

/** Input parameters for the deletion workflow. */
export interface DeletionParams {
  readonly request_id: string;
  readonly user_id: string;
}

// ---------------------------------------------------------------------------
// Step result types
// ---------------------------------------------------------------------------

/** Result of a single deletion step. */
export interface StepResult {
  readonly step: string;
  readonly deleted: number;
  readonly ok: boolean;
}

/** Complete deletion workflow result. */
export interface DeletionResult {
  readonly request_id: string;
  readonly user_id: string;
  readonly steps: readonly StepResult[];
  readonly completed_at: string;
}

// ---------------------------------------------------------------------------
// D1 helper types
// ---------------------------------------------------------------------------

interface D1AccountRow {
  account_id: string;
  user_id: string;
  provider: string;
  email: string;
}

interface D1MirrorInfo {
  canonical_event_id: string;
  target_account_id: string;
  target_calendar_id: string;
  provider_event_id: string | null;
}

// ---------------------------------------------------------------------------
// DeletionWorkflow class
// ---------------------------------------------------------------------------

/**
 * DeletionWorkflow executes the 8-step cascading deletion for GDPR
 * right-to-erasure compliance.
 *
 * In production, this is wrapped in a WorkflowEntrypoint where each
 * step maps to ctx.step.do() with retries. For testing, the class is
 * instantiated directly with injectable dependencies.
 */
export class DeletionWorkflow {
  private readonly env: DeletionEnv;

  constructor(env: DeletionEnv) {
    this.env = env;
  }

  /**
   * Execute the full 8-step cascading deletion.
   *
   * Steps execute sequentially. Each step is idempotent -- if a step
   * fails and is retried, re-executing produces the same end state.
   */
  async run(params: DeletionParams): Promise<DeletionResult> {
    const { request_id, user_id } = params;
    const steps: StepResult[] = [];

    // Get the UserGraphDO stub for this user
    const doId = this.env.USER_GRAPH.idFromName(user_id);
    const doStub = this.env.USER_GRAPH.get(doId);

    // Pre-fetch account data needed by step 7, BEFORE step 5 deletes it.
    // This is safe because step 7 only reads the pre-fetched data.
    // If accounts are already gone (retry after step 5 completed), we get
    // an empty list, which is fine -- provider deletions are best-effort.
    const { results: accounts } = await this.env.DB.prepare(
      "SELECT account_id, user_id, provider, email FROM accounts WHERE user_id = ?1",
    )
      .bind(user_id)
      .all<D1AccountRow>();

    // Step 1: Delete canonical events from UserGraphDO SQLite
    steps.push(await this.step1_deleteEvents(doStub));

    // Step 2: Delete event mirrors from UserGraphDO SQLite
    steps.push(await this.step2_deleteMirrors(doStub));

    // Step 3: Delete journal entries from UserGraphDO SQLite
    steps.push(await this.step3_deleteJournal(doStub));

    // Step 4: Delete relationship/ledger/milestone data from UserGraphDO SQLite
    steps.push(await this.step4_deleteRelationshipData(doStub));

    // Step 5: Delete D1 registry rows (users, accounts)
    steps.push(await this.step5_deleteD1Registry(user_id));

    // Step 6: Delete R2 audit objects
    steps.push(await this.step6_deleteR2AuditObjects(user_id));

    // Step 7: Enqueue provider-side mirror deletions (uses pre-fetched accounts)
    steps.push(await this.step7_enqueueProviderDeletions(user_id, accounts));

    // Step 8: Update deletion_requests status to 'completed'
    steps.push(await this.step8_markCompleted(request_id));

    return {
      request_id,
      user_id,
      steps,
      completed_at: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Individual steps
  // -------------------------------------------------------------------------

  /**
   * Step 1: Delete all canonical events from UserGraphDO.
   * RPC call via fetch to /deleteAllEvents.
   * Idempotent: DELETE FROM on empty table returns 0.
   */
  async step1_deleteEvents(doStub: DurableObjectStub): Promise<StepResult> {
    const resp = await doStub.fetch(
      new Request("https://do/deleteAllEvents", { method: "POST" }),
    );
    const data = (await resp.json()) as { deleted: number };
    return { step: "delete_events", deleted: data.deleted, ok: true };
  }

  /**
   * Step 2: Delete all event mirrors from UserGraphDO.
   * RPC call via fetch to /deleteAllMirrors.
   * Idempotent: DELETE FROM on empty table returns 0.
   */
  async step2_deleteMirrors(doStub: DurableObjectStub): Promise<StepResult> {
    const resp = await doStub.fetch(
      new Request("https://do/deleteAllMirrors", { method: "POST" }),
    );
    const data = (await resp.json()) as { deleted: number };
    return { step: "delete_mirrors", deleted: data.deleted, ok: true };
  }

  /**
   * Step 3: Delete all journal entries from UserGraphDO.
   * RPC call via fetch to /deleteJournal.
   * Idempotent: DELETE FROM on empty table returns 0.
   */
  async step3_deleteJournal(doStub: DurableObjectStub): Promise<StepResult> {
    const resp = await doStub.fetch(
      new Request("https://do/deleteJournal", { method: "POST" }),
    );
    const data = (await resp.json()) as { deleted: number };
    return { step: "delete_journal", deleted: data.deleted, ok: true };
  }

  /**
   * Step 4: Delete all relationship/ledger/milestone data from UserGraphDO.
   * RPC call via fetch to /deleteRelationshipData.
   * Idempotent: DELETE FROM on empty tables returns 0.
   */
  async step4_deleteRelationshipData(
    doStub: DurableObjectStub,
  ): Promise<StepResult> {
    const resp = await doStub.fetch(
      new Request("https://do/deleteRelationshipData", { method: "POST" }),
    );
    const data = (await resp.json()) as { deleted: number };
    return {
      step: "delete_relationship_data",
      deleted: data.deleted,
      ok: true,
    };
  }

  /**
   * Step 5: Delete D1 registry rows for this user.
   *
   * Deletes in order (respecting FK constraints):
   * 1. accounts (references users.user_id)
   * 2. api_keys (references users.user_id)
   * 3. users
   *
   * Idempotent: DELETE WHERE user_id = ? on empty result is a no-op.
   */
  async step5_deleteD1Registry(userId: string): Promise<StepResult> {
    let deleted = 0;

    // Delete accounts first (FK to users)
    const accountResult = await this.env.DB.prepare(
      "DELETE FROM accounts WHERE user_id = ?1",
    )
      .bind(userId)
      .run();
    deleted += accountResult.meta.changes ?? 0;

    // Delete API keys (FK to users)
    const apiKeyResult = await this.env.DB.prepare(
      "DELETE FROM api_keys WHERE user_id = ?1",
    )
      .bind(userId)
      .run();
    deleted += apiKeyResult.meta.changes ?? 0;

    // Delete user row
    const userResult = await this.env.DB.prepare(
      "DELETE FROM users WHERE user_id = ?1",
    )
      .bind(userId)
      .run();
    deleted += userResult.meta.changes ?? 0;

    return { step: "delete_d1_registry", deleted, ok: true };
  }

  /**
   * Step 6: Delete all R2 audit objects for this user.
   *
   * Lists all objects with prefix `{user_id}/` and deletes them in batches.
   * Handles pagination via cursor for users with many audit objects.
   *
   * Idempotent: listing an empty prefix returns empty, delete on missing
   * keys is a no-op.
   */
  async step6_deleteR2AuditObjects(userId: string): Promise<StepResult> {
    let deleted = 0;
    let cursor: string | undefined;
    const prefix = `${userId}/`;

    // Paginate through all objects with this user's prefix
    do {
      const listResult = await this.env.R2_AUDIT.list({
        prefix,
        cursor,
      });

      if (listResult.objects.length > 0) {
        const keys = listResult.objects.map((obj) => obj.key);
        await this.env.R2_AUDIT.delete(keys);
        deleted += keys.length;
      }

      cursor = listResult.truncated ? listResult.cursor : undefined;
    } while (cursor);

    return { step: "delete_r2_audit", deleted, ok: true };
  }

  /**
   * Step 7: Enqueue provider-side mirror deletions to write-queue.
   *
   * For each connected account, enqueue DELETE_USER_MIRRORS messages so
   * the write-consumer removes mirrored events from Google Calendar.
   *
   * Accounts are pre-fetched in run() BEFORE step 5 deletes D1 rows.
   * If accounts were already deleted (retry scenario), the pre-fetch
   * returns empty and this step is a safe no-op.
   *
   * Idempotent: sending duplicate DELETE_USER_MIRRORS messages is safe
   * (write-consumer handles not-found gracefully).
   */
  async step7_enqueueProviderDeletions(
    userId: string,
    accounts: readonly D1AccountRow[],
  ): Promise<StepResult> {
    let enqueued = 0;

    for (const account of accounts) {
      await this.env.WRITE_QUEUE.send({
        type: "DELETE_USER_MIRRORS",
        user_id: userId,
        account_id: account.account_id,
        provider: account.provider,
      });
      enqueued++;
    }

    return { step: "enqueue_provider_deletions", deleted: enqueued, ok: true };
  }

  /**
   * Step 8: Mark the deletion request as completed in D1.
   *
   * Updates deletion_requests.status to 'completed' and sets completed_at.
   * Only updates rows with status 'processing' to prevent double-completion.
   *
   * Idempotent: if already 'completed', the WHERE clause matches 0 rows.
   */
  async step8_markCompleted(requestId: string): Promise<StepResult> {
    const completedAt = new Date().toISOString();
    const result = await this.env.DB.prepare(
      `UPDATE deletion_requests
       SET status = 'completed', completed_at = ?1
       WHERE request_id = ?2 AND status = 'processing'`,
    )
      .bind(completedAt, requestId)
      .run();

    const updated = result.meta.changes ?? 0;
    return { step: "mark_completed", deleted: updated, ok: true };
  }
}
