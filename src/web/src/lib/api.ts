/**
 * API client for the T-Minus SPA.
 *
 * All requests go through /api/* which the app-gateway proxies to the
 * api-worker. JWT is passed in the Authorization header.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Standard API envelope from the tminus-api worker. */
interface ApiEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string | { code: string; message: string };
  meta?: {
    request_id?: string;
    timestamp?: string;
    next_cursor?: string;
  };
}

/** Login/register response shape. */
export interface AuthResponse {
  user: { id: string; email: string; tier: string };
  access_token: string;
  refresh_token: string;
}

/** Mirror sync status for an event on a target account. */
export type MirrorSyncStatus = "ACTIVE" | "PENDING" | "ERROR";

/** Mirror entry: how an event appears on a target account. */
export interface EventMirror {
  target_account_id: string;
  target_account_email?: string;
  sync_status: MirrorSyncStatus;
  last_error?: string;
}

/** Canonical event shape. */
export interface CalendarEvent {
  canonical_event_id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  origin_account_id?: string;
  origin_account_email?: string;
  status?: string;
  version?: number;
  updated_at?: string;
  mirrors?: EventMirror[];
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ---------------------------------------------------------------------------
// Core fetch wrapper
// ---------------------------------------------------------------------------

/**
 * Make an authenticated API request.
 *
 * @param path - API path (e.g., "/v1/events"). Will be prefixed with /api.
 * @param options - Fetch options (method, body, etc.)
 * @param token - JWT access token (optional for auth endpoints)
 * @returns The envelope data on success
 * @throws ApiError on non-2xx responses
 */
export async function apiFetch<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string | null;
  } = {},
): Promise<T> {
  const { method = "GET", body, token } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const response = await fetch(`/api${path}`, init);
  const envelope = (await response.json()) as ApiEnvelope<T>;

  if (!response.ok || !envelope.ok) {
    const errMsg =
      typeof envelope.error === "string"
        ? envelope.error
        : typeof envelope.error === "object" && envelope.error?.message
          ? envelope.error.message
          : "Request failed";
    const errCode =
      typeof envelope.error === "object" && envelope.error?.code
        ? envelope.error.code
        : "UNKNOWN";
    throw new ApiError(response.status, errCode, errMsg);
  }

  return envelope.data as T;
}

// ---------------------------------------------------------------------------
// Convenience methods
// ---------------------------------------------------------------------------

/** POST /api/v1/auth/login */
export async function login(
  email: string,
  password: string,
): Promise<AuthResponse> {
  return apiFetch<AuthResponse>("/v1/auth/login", {
    method: "POST",
    body: { email, password },
  });
}

/** GET /api/v1/events with optional date range query params. */
export async function fetchEvents(
  token: string,
  params?: { start?: string; end?: string },
): Promise<CalendarEvent[]> {
  const search = new URLSearchParams();
  if (params?.start) search.set("start", params.start);
  if (params?.end) search.set("end", params.end);
  const qs = search.toString();
  const path = `/v1/events${qs ? `?${qs}` : ""}`;
  return apiFetch<CalendarEvent[]>(path, { token });
}

/** GET /api/v1/sync/status -- per-account sync health dashboard data. */
export async function fetchSyncStatus(
  token: string,
): Promise<import("./sync-status").SyncStatusResponse> {
  return apiFetch<import("./sync-status").SyncStatusResponse>(
    "/v1/sync/status",
    { token },
  );
}
