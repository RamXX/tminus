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

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** POST /api/v1/scheduling/sessions -- create a new scheduling session. */
export async function createSchedulingSession(
  token: string,
  payload: import("./scheduling").CreateSessionPayload,
): Promise<import("./scheduling").SchedulingSession> {
  return apiFetch<import("./scheduling").SchedulingSession>(
    "/v1/scheduling/sessions",
    { method: "POST", body: payload, token },
  );
}

/** GET /api/v1/scheduling/sessions/:id -- get a single scheduling session. */
export async function getSession(
  token: string,
  sessionId: string,
): Promise<import("./scheduling").SchedulingSession> {
  return apiFetch<import("./scheduling").SchedulingSession>(
    `/v1/scheduling/sessions/${encodeURIComponent(sessionId)}`,
    { token },
  );
}

/** GET /api/v1/scheduling/sessions -- list all scheduling sessions. */
export async function listSessions(
  token: string,
): Promise<import("./scheduling").SchedulingSession[]> {
  return apiFetch<import("./scheduling").SchedulingSession[]>(
    "/v1/scheduling/sessions",
    { token },
  );
}

/** DELETE /api/v1/scheduling/sessions/:id -- cancel a scheduling session. */
export async function cancelSession(
  token: string,
  sessionId: string,
): Promise<import("./scheduling").CancelResponse> {
  return apiFetch<import("./scheduling").CancelResponse>(
    `/v1/scheduling/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE", token },
  );
}

/** POST /api/v1/scheduling/sessions/:id/commit/:candidateId -- commit a candidate. */
export async function commitCandidate(
  token: string,
  sessionId: string,
  candidateId: string,
): Promise<import("./scheduling").CommitResponse> {
  return apiFetch<import("./scheduling").CommitResponse>(
    `/v1/scheduling/sessions/${encodeURIComponent(sessionId)}/commit/${encodeURIComponent(candidateId)}`,
    { method: "POST", token },
  );
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

/** GET /api/v1/commitments -- list all commitments. */
export async function fetchCommitments(
  token: string,
): Promise<import("./governance").Commitment[]> {
  return apiFetch<import("./governance").Commitment[]>(
    "/v1/commitments",
    { token },
  );
}

/** GET /api/v1/vips -- list VIP contacts. */
export async function fetchVips(
  token: string,
): Promise<import("./governance").VipContact[]> {
  return apiFetch<import("./governance").VipContact[]>(
    "/v1/vips",
    { token },
  );
}

/** POST /api/v1/vips -- add a VIP contact. */
export async function addVip(
  token: string,
  payload: import("./governance").AddVipPayload,
): Promise<import("./governance").VipContact> {
  return apiFetch<import("./governance").VipContact>(
    "/v1/vips",
    { method: "POST", body: payload, token },
  );
}

/** DELETE /api/v1/vips/:id -- remove a VIP contact. */
export async function removeVip(
  token: string,
  vipId: string,
): Promise<void> {
  return apiFetch<void>(
    `/v1/vips/${encodeURIComponent(vipId)}`,
    { method: "DELETE", token },
  );
}

/** POST /api/v1/commitments/:id/export -- export proof for a commitment. */
export async function exportCommitmentProof(
  token: string,
  commitmentId: string,
): Promise<import("./governance").ExportProofResponse> {
  return apiFetch<import("./governance").ExportProofResponse>(
    `/v1/commitments/${encodeURIComponent(commitmentId)}/export`,
    { method: "POST", token },
  );
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

/** GET /api/v1/relationships -- list all relationships. */
export async function fetchRelationships(
  token: string,
  sort?: string,
): Promise<import("./relationships").Relationship[]> {
  const qs = sort ? `?sort=${encodeURIComponent(sort)}` : "";
  return apiFetch<import("./relationships").Relationship[]>(
    `/v1/relationships${qs}`,
    { token },
  );
}

/** POST /api/v1/relationships -- create a new relationship. */
export async function createRelationship(
  token: string,
  payload: import("./relationships").CreateRelationshipPayload,
): Promise<import("./relationships").Relationship> {
  return apiFetch<import("./relationships").Relationship>(
    "/v1/relationships",
    { method: "POST", body: payload, token },
  );
}

/** GET /api/v1/relationships/:id -- get a single relationship. */
export async function fetchRelationship(
  token: string,
  id: string,
): Promise<import("./relationships").Relationship> {
  return apiFetch<import("./relationships").Relationship>(
    `/v1/relationships/${encodeURIComponent(id)}`,
    { token },
  );
}

/** PUT /api/v1/relationships/:id -- update a relationship. */
export async function updateRelationship(
  token: string,
  id: string,
  payload: import("./relationships").UpdateRelationshipPayload,
): Promise<import("./relationships").Relationship> {
  return apiFetch<import("./relationships").Relationship>(
    `/v1/relationships/${encodeURIComponent(id)}`,
    { method: "PUT", body: payload, token },
  );
}

/** DELETE /api/v1/relationships/:id -- delete a relationship. */
export async function deleteRelationship(
  token: string,
  id: string,
): Promise<void> {
  return apiFetch<void>(
    `/v1/relationships/${encodeURIComponent(id)}`,
    { method: "DELETE", token },
  );
}

/** GET /api/v1/relationships/:id/reputation -- get reputation scores. */
export async function fetchReputation(
  token: string,
  id: string,
): Promise<import("./relationships").ReputationScores> {
  return apiFetch<import("./relationships").ReputationScores>(
    `/v1/relationships/${encodeURIComponent(id)}/reputation`,
    { token },
  );
}

/** POST /api/v1/relationships/:id/outcomes -- record an outcome. */
export async function createOutcome(
  token: string,
  relationshipId: string,
  payload: import("./relationships").CreateOutcomePayload,
): Promise<import("./relationships").Outcome> {
  return apiFetch<import("./relationships").Outcome>(
    `/v1/relationships/${encodeURIComponent(relationshipId)}/outcomes`,
    { method: "POST", body: payload, token },
  );
}

/** GET /api/v1/relationships/:id/outcomes -- list outcomes. */
export async function fetchOutcomes(
  token: string,
  relationshipId: string,
): Promise<import("./relationships").Outcome[]> {
  return apiFetch<import("./relationships").Outcome[]>(
    `/v1/relationships/${encodeURIComponent(relationshipId)}/outcomes`,
    { token },
  );
}

/** GET /api/v1/drift-report -- get drift report. */
export async function fetchDriftReport(
  token: string,
): Promise<import("./relationships").DriftReport> {
  return apiFetch<import("./relationships").DriftReport>(
    "/v1/drift-report",
    { token },
  );
}

/** GET /api/v1/drift-alerts -- get drift alerts. */
export async function fetchDriftAlerts(
  token: string,
): Promise<import("./relationships").DriftAlert[]> {
  return apiFetch<import("./relationships").DriftAlert[]>(
    "/v1/drift-alerts",
    { token },
  );
}

/** GET /api/v1/reconnection-suggestions -- get reconnection suggestions. */
export async function fetchReconnectionSuggestions(
  token: string,
): Promise<import("./relationships").ReconnectionSuggestion[]> {
  return apiFetch<import("./relationships").ReconnectionSuggestion[]>(
    "/v1/reconnection-suggestions",
    { token },
  );
}

// ---------------------------------------------------------------------------
// Reconnections (full typed for dashboard)
// ---------------------------------------------------------------------------

/** GET /api/v1/reconnection-suggestions -- full typed for reconnection dashboard. */
export async function fetchReconnectionSuggestionsFull(
  token: string,
): Promise<import("./reconnections").ReconnectionSuggestionFull[]> {
  return apiFetch<import("./reconnections").ReconnectionSuggestionFull[]>(
    "/v1/reconnection-suggestions",
    { token },
  );
}

/** GET /api/v1/milestones/upcoming -- upcoming milestones within N days. */
export async function fetchUpcomingMilestones(
  token: string,
  days: number = 30,
): Promise<import("./reconnections").UpcomingMilestone[]> {
  return apiFetch<import("./reconnections").UpcomingMilestone[]>(
    `/v1/milestones/upcoming?days=${days}`,
    { token },
  );
}

// ---------------------------------------------------------------------------
// Briefing & Excuse
// ---------------------------------------------------------------------------

/** GET /api/v1/events/:id/briefing -- fetch pre-meeting context briefing. */
export async function fetchEventBriefing(
  token: string,
  eventId: string,
): Promise<import("./briefing").EventBriefing> {
  return apiFetch<import("./briefing").EventBriefing>(
    `/v1/events/${encodeURIComponent(eventId)}/briefing`,
    { token },
  );
}

/** POST /api/v1/events/:id/excuse -- generate an excuse draft. */
export async function generateExcuse(
  token: string,
  eventId: string,
  params: { tone: import("./briefing").ExcuseTone; truth_level: import("./briefing").TruthLevel },
): Promise<import("./briefing").ExcuseOutput> {
  return apiFetch<import("./briefing").ExcuseOutput>(
    `/v1/events/${encodeURIComponent(eventId)}/excuse`,
    { method: "POST", body: params, token },
  );
}
