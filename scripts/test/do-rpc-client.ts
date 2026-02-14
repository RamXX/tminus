/**
 * HTTP client for calling Durable Objects via the test worker's RPC proxy.
 *
 * Each method maps to a DO RPC endpoint:
 *   POST /do/:namespace/:doName/:methodPath -> { ...response }
 *
 * Usage:
 *   const client = new DoRpcClient("http://127.0.0.1:18799");
 *   const result = await client.account("acct-1").initialize(tokens, scopes);
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DoRpcClientConfig {
  baseUrl: string;
}

// ---------------------------------------------------------------------------
// DoRpcClient
// ---------------------------------------------------------------------------

export class DoRpcClient {
  private baseUrl: string;

  constructor(config: DoRpcClientConfig) {
    this.baseUrl = config.baseUrl;
  }

  /** Get a handle to an AccountDO instance by name. */
  account(name: string): AccountDoHandle {
    return new AccountDoHandle(this.baseUrl, name);
  }

  /** Get a handle to a UserGraphDO instance by name. */
  userGraph(name: string): UserGraphDoHandle {
    return new UserGraphDoHandle(this.baseUrl, name);
  }
}

// ---------------------------------------------------------------------------
// Raw RPC call helper
// ---------------------------------------------------------------------------

async function rpcCall<T>(
  baseUrl: string,
  namespace: string,
  doName: string,
  path: string,
  body: unknown = {},
): Promise<{ status: number; data: T }> {
  const url = `${baseUrl}/do/${namespace}/${doName}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await response.text();

  // Try to parse as JSON; if that fails, wrap the text in an object
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    // Non-JSON response (e.g., plain text 404 from DO)
    data = { text } as unknown as T;
  }

  return { status: response.status, data };
}

// ---------------------------------------------------------------------------
// AccountDO handle
// ---------------------------------------------------------------------------

export class AccountDoHandle {
  constructor(
    private baseUrl: string,
    private doName: string,
  ) {}

  async initialize(
    tokens: { access_token: string; refresh_token: string; expiry: string },
    scopes: string,
  ): Promise<{ ok: boolean }> {
    const result = await rpcCall<{ ok: boolean }>(
      this.baseUrl,
      "ACCOUNT",
      this.doName,
      "/initialize",
      { tokens, scopes },
    );
    return result.data;
  }

  async getAccessToken(): Promise<{
    access_token?: string;
    error?: string;
  }> {
    const result = await rpcCall<{
      access_token?: string;
      error?: string;
    }>(this.baseUrl, "ACCOUNT", this.doName, "/getAccessToken");
    return result.data;
  }

  async getSyncToken(): Promise<{ sync_token: string | null }> {
    const result = await rpcCall<{ sync_token: string | null }>(
      this.baseUrl,
      "ACCOUNT",
      this.doName,
      "/getSyncToken",
    );
    return result.data;
  }

  async setSyncToken(
    syncToken: string,
  ): Promise<{ ok: boolean }> {
    const result = await rpcCall<{ ok: boolean }>(
      this.baseUrl,
      "ACCOUNT",
      this.doName,
      "/setSyncToken",
      { sync_token: syncToken },
    );
    return result.data;
  }

  async markSyncSuccess(ts: string): Promise<{ ok: boolean }> {
    const result = await rpcCall<{ ok: boolean }>(
      this.baseUrl,
      "ACCOUNT",
      this.doName,
      "/markSyncSuccess",
      { ts },
    );
    return result.data;
  }

  async markSyncFailure(error: string): Promise<{ ok: boolean }> {
    const result = await rpcCall<{ ok: boolean }>(
      this.baseUrl,
      "ACCOUNT",
      this.doName,
      "/markSyncFailure",
      { error },
    );
    return result.data;
  }

  async revokeTokens(): Promise<{
    ok: boolean;
    revoked: boolean;
    error?: string;
  }> {
    const result = await rpcCall<{
      ok: boolean;
      revoked: boolean;
      error?: string;
    }>(this.baseUrl, "ACCOUNT", this.doName, "/revokeTokens");
    return result.data;
  }

  async registerChannel(
    calendarId: string,
  ): Promise<{ channelId: string; expiry: string }> {
    const result = await rpcCall<{ channelId: string; expiry: string }>(
      this.baseUrl,
      "ACCOUNT",
      this.doName,
      "/registerChannel",
      { calendar_id: calendarId },
    );
    return result.data;
  }

  async getChannelStatus(): Promise<{
    channels: Array<{
      channelId: string;
      calendarId: string;
      status: string;
      expiryTs: string;
    }>;
  }> {
    const result = await rpcCall<{
      channels: Array<{
        channelId: string;
        calendarId: string;
        status: string;
        expiryTs: string;
      }>;
    }>(this.baseUrl, "ACCOUNT", this.doName, "/getChannelStatus");
    return result.data;
  }

  async getHealth(): Promise<{
    lastSyncTs: string | null;
    lastSuccessTs: string | null;
    fullSyncNeeded: boolean;
  }> {
    const result = await rpcCall<{
      lastSyncTs: string | null;
      lastSuccessTs: string | null;
      fullSyncNeeded: boolean;
    }>(this.baseUrl, "ACCOUNT", this.doName, "/getHealth");
    return result.data;
  }

  /** Send a raw RPC call (for testing error cases). */
  async raw<T>(path: string, body?: unknown): Promise<{ status: number; data: T }> {
    return rpcCall<T>(this.baseUrl, "ACCOUNT", this.doName, path, body);
  }
}

// ---------------------------------------------------------------------------
// UserGraphDO handle
// ---------------------------------------------------------------------------

export interface ProviderDeltaPayload {
  type: "created" | "updated" | "deleted";
  origin_event_id: string;
  origin_account_id?: string;
  event?: {
    origin_account_id?: string;
    origin_event_id?: string;
    title?: string;
    description?: string;
    location?: string;
    start: { dateTime?: string; date?: string; timeZone?: string };
    end: { dateTime?: string; date?: string; timeZone?: string };
    all_day?: boolean;
    status?: string;
    visibility?: string;
    transparency?: string;
    recurrence_rule?: string;
  };
}

export interface ApplyResultPayload {
  created: number;
  updated: number;
  deleted: number;
  mirrors_enqueued: number;
  errors: Array<{ origin_event_id: string; error: string }>;
}

export class UserGraphDoHandle {
  constructor(
    private baseUrl: string,
    private doName: string,
  ) {}

  async applyProviderDelta(
    accountId: string,
    deltas: ProviderDeltaPayload[],
  ): Promise<ApplyResultPayload> {
    const result = await rpcCall<ApplyResultPayload>(
      this.baseUrl,
      "USER_GRAPH",
      this.doName,
      "/applyProviderDelta",
      { account_id: accountId, deltas },
    );
    return result.data;
  }

  async listCanonicalEvents(
    query: {
      time_min?: string;
      time_max?: string;
      origin_account_id?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<{
    items: Array<Record<string, unknown>>;
    cursor: string | null;
    has_more: boolean;
  }> {
    const result = await rpcCall<{
      items: Array<Record<string, unknown>>;
      cursor: string | null;
      has_more: boolean;
    }>(
      this.baseUrl,
      "USER_GRAPH",
      this.doName,
      "/listCanonicalEvents",
      query,
    );
    return result.data;
  }

  async getCanonicalEvent(
    canonicalEventId: string,
  ): Promise<{
    event: Record<string, unknown>;
    mirrors: Array<Record<string, unknown>>;
  } | null> {
    const result = await rpcCall<{
      event: Record<string, unknown>;
      mirrors: Array<Record<string, unknown>>;
    } | null>(
      this.baseUrl,
      "USER_GRAPH",
      this.doName,
      "/getCanonicalEvent",
      { canonical_event_id: canonicalEventId },
    );
    return result.data;
  }

  async createPolicy(name: string): Promise<{
    policy_id: string;
    name: string;
    is_default: boolean;
    created_at: string;
  }> {
    const result = await rpcCall<{
      policy_id: string;
      name: string;
      is_default: boolean;
      created_at: string;
    }>(this.baseUrl, "USER_GRAPH", this.doName, "/createPolicy", { name });
    return result.data;
  }

  async setPolicyEdges(
    policyId: string,
    edges: Array<{
      from_account_id: string;
      to_account_id: string;
      detail_level: string;
      calendar_kind: string;
    }>,
  ): Promise<{ ok: boolean }> {
    const result = await rpcCall<{ ok: boolean }>(
      this.baseUrl,
      "USER_GRAPH",
      this.doName,
      "/setPolicyEdges",
      { policy_id: policyId, edges },
    );
    return result.data;
  }

  async ensureDefaultPolicy(accounts: string[]): Promise<{ ok: boolean }> {
    const result = await rpcCall<{ ok: boolean }>(
      this.baseUrl,
      "USER_GRAPH",
      this.doName,
      "/ensureDefaultPolicy",
      { accounts },
    );
    return result.data;
  }

  async queryJournal(
    query: {
      canonical_event_id?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<{
    items: Array<{
      journal_id: string;
      canonical_event_id: string;
      ts: string;
      actor: string;
      change_type: string;
      patch_json: string | null;
      reason: string | null;
    }>;
    cursor: string | null;
    has_more: boolean;
  }> {
    const result = await rpcCall<{
      items: Array<{
        journal_id: string;
        canonical_event_id: string;
        ts: string;
        actor: string;
        change_type: string;
        patch_json: string | null;
        reason: string | null;
      }>;
      cursor: string | null;
      has_more: boolean;
    }>(this.baseUrl, "USER_GRAPH", this.doName, "/queryJournal", query);
    return result.data;
  }

  async getSyncHealth(): Promise<{
    total_events: number;
    total_mirrors: number;
    total_journal_entries: number;
    pending_mirrors: number;
    error_mirrors: number;
    last_journal_ts: string | null;
  }> {
    const result = await rpcCall<{
      total_events: number;
      total_mirrors: number;
      total_journal_entries: number;
      pending_mirrors: number;
      error_mirrors: number;
      last_journal_ts: string | null;
    }>(this.baseUrl, "USER_GRAPH", this.doName, "/getSyncHealth");
    return result.data;
  }

  async computeAvailability(query: {
    start: string;
    end: string;
    accounts?: string[];
  }): Promise<{
    busy_intervals: Array<{
      start: string;
      end: string;
      account_ids: string[];
    }>;
    free_intervals: Array<{ start: string; end: string }>;
  }> {
    const result = await rpcCall<{
      busy_intervals: Array<{
        start: string;
        end: string;
        account_ids: string[];
      }>;
      free_intervals: Array<{ start: string; end: string }>;
    }>(this.baseUrl, "USER_GRAPH", this.doName, "/computeAvailability", query);
    return result.data;
  }

  async unlinkAccount(
    accountId: string,
  ): Promise<{
    events_deleted: number;
    mirrors_deleted: number;
    policy_edges_removed: number;
    calendars_removed: number;
  }> {
    const result = await rpcCall<{
      events_deleted: number;
      mirrors_deleted: number;
      policy_edges_removed: number;
      calendars_removed: number;
    }>(this.baseUrl, "USER_GRAPH", this.doName, "/unlinkAccount", {
      account_id: accountId,
    });
    // The response from the DO's handleFetch wraps the result in a Response.json()
    // but the handleFetch for unlinkAccount is actually via /unlinkAccount
    return result.data;
  }

  /** Send a raw RPC call. */
  async raw<T>(path: string, body?: unknown): Promise<{ status: number; data: T }> {
    return rpcCall<T>(this.baseUrl, "USER_GRAPH", this.doName, path, body);
  }
}
