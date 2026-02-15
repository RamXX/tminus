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

/** Payload for creating a new event via the API. */
export interface CreateEventPayload {
  summary: string;
  start: string;
  end: string;
  timezone?: string;
  description?: string;
  location?: string;
  source: "ui";
}

/** Payload for updating an existing event via the API. */
export interface UpdateEventPayload {
  summary?: string;
  start?: string;
  end?: string;
  timezone?: string;
  description?: string;
  location?: string;
}

/** Provider type for linked calendar accounts. */
export type AccountProvider = "google" | "microsoft";

/** Status of a linked calendar account. */
export type AccountStatus = "active" | "error" | "revoked" | "pending";

/** Linked calendar account shape from the API. */
export interface LinkedAccount {
  account_id: string;
  email: string;
  provider: AccountProvider;
  status: AccountStatus;
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

/** POST /api/v1/events -- create a new canonical event. */
export async function createEvent(
  token: string,
  payload: CreateEventPayload,
): Promise<CalendarEvent> {
  return apiFetch<CalendarEvent>("/v1/events", {
    method: "POST",
    body: payload,
    token,
  });
}

/** PATCH /api/v1/events/:id -- update an existing canonical event. */
export async function updateEvent(
  token: string,
  eventId: string,
  payload: UpdateEventPayload,
): Promise<CalendarEvent> {
  return apiFetch<CalendarEvent>(`/v1/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    body: payload,
    token,
  });
}

/** DELETE /api/v1/events/:id -- delete a canonical event. */
export async function deleteEvent(
  token: string,
  eventId: string,
): Promise<void> {
  return apiFetch<void>(`/v1/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    token,
  });
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

/** GET /api/v1/accounts -- list linked calendar accounts. */
export async function fetchAccounts(
  token: string,
): Promise<LinkedAccount[]> {
  return apiFetch<LinkedAccount[]>("/v1/accounts", { token });
}

/** DELETE /api/v1/accounts/:id -- unlink a calendar account. */
export async function unlinkAccount(
  token: string,
  accountId: string,
): Promise<void> {
  return apiFetch<void>(`/v1/accounts/${encodeURIComponent(accountId)}`, {
    method: "DELETE",
    token,
  });
}

/** GET /api/v1/sync/journal?change_type=error -- fetch mirrors in ERROR state. */
export async function fetchErrorMirrors(
  token: string,
): Promise<import("./error-recovery").ErrorMirror[]> {
  return apiFetch<import("./error-recovery").ErrorMirror[]>(
    "/v1/sync/journal?change_type=error",
    { token },
  );
}

/** POST /api/v1/sync/retry/:mirror_id -- retry a single failed mirror. */
export async function retryMirror(
  token: string,
  mirrorId: string,
): Promise<import("./error-recovery").RetryResult> {
  return apiFetch<import("./error-recovery").RetryResult>(
    `/v1/sync/retry/${encodeURIComponent(mirrorId)}`,
    { method: "POST", token },
  );
}

/** GET /api/v1/billing/status -- current subscription and plan info. */
export async function fetchBillingStatus(
  token: string,
): Promise<import("./billing").BillingStatusResponse> {
  return apiFetch<import("./billing").BillingStatusResponse>(
    "/v1/billing/status",
    { token },
  );
}

/** POST /api/v1/billing/checkout -- create a Stripe Checkout session. */
export async function createCheckoutSession(
  token: string,
  priceId: string,
): Promise<import("./billing").CheckoutResponse> {
  return apiFetch<import("./billing").CheckoutResponse>(
    "/v1/billing/checkout",
    { method: "POST", body: { price_id: priceId }, token },
  );
}

/** POST /api/v1/billing/portal -- create a Stripe Customer Portal session. */
export async function createPortalSession(
  token: string,
): Promise<import("./billing").PortalResponse> {
  return apiFetch<import("./billing").PortalResponse>(
    "/v1/billing/portal",
    { method: "POST", token },
  );
}

/** GET /api/v1/billing/events -- fetch billing event history. */
export async function fetchBillingHistory(
  token: string,
): Promise<import("./billing").BillingEvent[]> {
  return apiFetch<import("./billing").BillingEvent[]>(
    "/v1/billing/events",
    { token },
  );
}
