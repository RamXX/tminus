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
export type AccountProvider = "google" | "microsoft" | "apple";

/** Status of a linked calendar account. */
export type AccountStatus = "active" | "error" | "revoked" | "pending";

/** Linked calendar account shape from the API. */
export interface LinkedAccount {
  account_id: string;
  email: string;
  provider: AccountProvider;
  status: AccountStatus;
}

/** Calendar capability derived from the calendar_role. */
export type CalendarCapability = "read" | "write";

/** Access level for a scoped calendar. */
export type CalendarAccessLevel =
  | "owner"
  | "editor"
  | "readonly"
  | "freeBusyReader";

/** A single scoped calendar with capability metadata. */
export interface CalendarScope {
  scope_id: string;
  provider_calendar_id: string;
  display_name: string | null;
  calendar_role: string;
  access_level: CalendarAccessLevel;
  capabilities: CalendarCapability[];
  enabled: boolean;
  sync_enabled: boolean;
  /** Whether this scope is recommended for default selection. */
  recommended: boolean;
}

/** Response from GET /v1/accounts/:id/scopes. */
export interface AccountScopesResponse {
  account_id: string;
  provider: string;
  scopes: CalendarScope[];
}

/** Payload item for PUT /v1/accounts/:id/scopes. */
export interface ScopeUpdateItem {
  provider_calendar_id: string;
  enabled?: boolean;
  sync_enabled?: boolean;
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
// Event contract adapters (UI <-> canonical API)
// ---------------------------------------------------------------------------

interface CanonicalDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface CanonicalApiEvent {
  canonical_event_id?: string;
  summary?: string;
  title?: string;
  description?: string;
  location?: string;
  start?: string | CanonicalDateTime;
  end?: string | CanonicalDateTime;
  origin_account_id?: string;
  origin_account_email?: string;
  status?: string;
  version?: number;
  updated_at?: string;
  mirrors?: EventMirror[];
}

function hasExplicitOffset(value: string): boolean {
  return /(?:[zZ]|[+-]\d{2}:\d{2})$/.test(value);
}

function isUtcTimeZone(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toUpperCase();
  return (
    normalized === "UTC" ||
    normalized === "ETC/UTC" ||
    normalized === "GMT" ||
    normalized === "COORDINATED UNIVERSAL TIME" ||
    normalized === "UNIVERSAL COORDINATED TIME" ||
    normalized === "UTC+00:00" ||
    normalized === "UTC-00:00"
  );
}

function normalizeDateTime(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const v = value as CanonicalDateTime;
    if (typeof v.dateTime === "string") {
      // Microsoft Graph commonly emits UTC dateTimes without an explicit
      // offset. Attach "Z" so Date parsing is timezone-correct in the UI.
      if (!hasExplicitOffset(v.dateTime) && isUtcTimeZone(v.timeZone)) {
        return `${v.dateTime}Z`;
      }
      return v.dateTime;
    }
    if (typeof v.date === "string") return v.date;
  }
  return null;
}

function toCanonicalDateTime(
  value: string | undefined,
  timezone?: string,
): CanonicalDateTime | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { date: value };
  }
  if (timezone) {
    return { dateTime: value, timeZone: timezone };
  }
  return { dateTime: value };
}

function normalizeCalendarEvent(raw: unknown): CalendarEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const evt = raw as CanonicalApiEvent;
  const canonicalEventId =
    typeof evt.canonical_event_id === "string" ? evt.canonical_event_id : "";
  if (!canonicalEventId) return null;

  const start = normalizeDateTime(evt.start);
  const end = normalizeDateTime(evt.end);
  if (!start || !end) return null;

  return {
    canonical_event_id: canonicalEventId,
    summary:
      typeof evt.summary === "string"
        ? evt.summary
        : typeof evt.title === "string"
          ? evt.title
          : undefined,
    description:
      typeof evt.description === "string" ? evt.description : undefined,
    location: typeof evt.location === "string" ? evt.location : undefined,
    start,
    end,
    origin_account_id:
      typeof evt.origin_account_id === "string"
        ? evt.origin_account_id
        : undefined,
    origin_account_email:
      typeof evt.origin_account_email === "string"
        ? evt.origin_account_email
        : undefined,
    status: typeof evt.status === "string" ? evt.status : undefined,
    version: typeof evt.version === "number" ? evt.version : undefined,
    updated_at:
      typeof evt.updated_at === "string" ? evt.updated_at : undefined,
    mirrors: Array.isArray(evt.mirrors)
      ? (evt.mirrors as EventMirror[])
      : undefined,
  };
}

async function fetchEventById(
  token: string,
  eventId: string,
): Promise<CalendarEvent> {
  const payload = await apiFetch<{ event?: unknown; mirrors?: unknown[] }>(
    `/v1/events/${encodeURIComponent(eventId)}`,
    { token },
  );

  const eventBody =
    payload && typeof payload === "object" && "event" in payload
      ? (payload.event as Record<string, unknown>)
      : null;
  if (!eventBody) {
    throw new Error("Failed to parse event detail payload");
  }

  const normalized = normalizeCalendarEvent({
    ...eventBody,
    mirrors: Array.isArray(payload.mirrors)
      ? (payload.mirrors as EventMirror[])
      : undefined,
  });

  if (!normalized) {
    throw new Error("Failed to normalize event detail payload");
  }
  return normalized;
}

async function normalizeMutationResult(
  token: string,
  payload: unknown,
): Promise<CalendarEvent> {
  const normalizedDirect = normalizeCalendarEvent(payload);
  if (normalizedDirect) return normalizedDirect;

  if (payload && typeof payload === "object") {
    const maybeId = (payload as Record<string, unknown>).canonical_event_id;
    if (typeof maybeId === "string" && maybeId.length > 0) {
      return fetchEventById(token, maybeId);
    }
  }

  throw new Error("Malformed event payload from API");
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
  const data = await apiFetch<unknown[]>(path, { token });
  return (data ?? [])
    .map((evt) => normalizeCalendarEvent(evt))
    .filter((evt): evt is CalendarEvent => evt !== null);
}

/** POST /api/v1/events -- create a new canonical event. */
export async function createEvent(
  token: string,
  payload: CreateEventPayload,
): Promise<CalendarEvent> {
  const requestBody = {
    title: payload.summary,
    start: toCanonicalDateTime(payload.start, payload.timezone),
    end: toCanonicalDateTime(payload.end, payload.timezone),
    description: payload.description,
    location: payload.location,
    source: payload.source,
  };

  const result = await apiFetch<unknown>("/v1/events", {
    method: "POST",
    body: requestBody,
    token,
  });
  return normalizeMutationResult(token, result);
}

/** PATCH /api/v1/events/:id -- update an existing canonical event. */
export async function updateEvent(
  token: string,
  eventId: string,
  payload: UpdateEventPayload,
): Promise<CalendarEvent> {
  const requestBody: Record<string, unknown> = {};
  if (payload.summary !== undefined) requestBody.title = payload.summary;
  if (payload.start !== undefined) {
    requestBody.start = toCanonicalDateTime(payload.start, payload.timezone);
  }
  if (payload.end !== undefined) {
    requestBody.end = toCanonicalDateTime(payload.end, payload.timezone);
  }
  if (payload.description !== undefined) {
    requestBody.description = payload.description;
  }
  if (payload.location !== undefined) {
    requestBody.location = payload.location;
  }

  const result = await apiFetch<unknown>(
    `/v1/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      body: requestBody,
      token,
    },
  );
  return normalizeMutationResult(token, result);
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

/** Account detail with health info (from GET /v1/accounts/:id). */
export interface AccountDetail {
  account_id: string;
  user_id: string;
  provider: AccountProvider;
  email: string;
  status: AccountStatus;
  created_at: string;
  health: {
    lastSyncTs: string | null;
    lastSuccessTs: string | null;
    fullSyncNeeded: boolean;
  } | null;
}

/** GET /api/v1/accounts/:id -- get a single account with health info. */
export async function fetchAccountDetail(
  token: string,
  accountId: string,
): Promise<AccountDetail> {
  return apiFetch<AccountDetail>(
    `/v1/accounts/${encodeURIComponent(accountId)}`,
    { token },
  );
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

// ---------------------------------------------------------------------------
// Onboarding session management
// ---------------------------------------------------------------------------

/** POST /api/v1/onboarding/session -- create a new onboarding session. */
export async function createOnboardingSession(
  token: string,
): Promise<import("./onboarding-session").OnboardingSession> {
  return apiFetch<import("./onboarding-session").OnboardingSession>(
    "/v1/onboarding/session",
    { method: "POST", token },
  );
}

/** GET /api/v1/onboarding/session -- get the current onboarding session. */
export async function getOnboardingSession(
  token: string,
): Promise<import("./onboarding-session").OnboardingSession | null> {
  return apiFetch<import("./onboarding-session").OnboardingSession | null>(
    "/v1/onboarding/session",
    { token },
  );
}

/** GET /api/v1/onboarding/status -- lightweight status for cross-tab polling. */
export async function getOnboardingStatus(
  token: string,
): Promise<{
  active: boolean;
  session_id?: string;
  step?: string;
  account_count?: number;
  accounts?: Array<{
    account_id: string;
    provider: string;
    email: string;
    status: string;
    calendar_count?: number;
    connected_at: string;
  }>;
  updated_at?: string;
  completed_at?: string;
}> {
  return apiFetch("/v1/onboarding/status", { token });
}

/** POST /api/v1/onboarding/session/account -- add account to session. */
export async function addOnboardingAccount(
  token: string,
  payload: {
    account_id: string;
    provider: string;
    email: string;
    calendar_count?: number;
  },
): Promise<void> {
  await apiFetch("/v1/onboarding/session/account", {
    method: "POST",
    body: payload,
    token,
  });
}

/** POST /api/v1/onboarding/session/complete -- mark session complete. */
export async function completeOnboardingSession(
  token: string,
): Promise<void> {
  await apiFetch("/v1/onboarding/session/complete", {
    method: "POST",
    token,
  });
}

// ---------------------------------------------------------------------------
// Provider Health Dashboard
// ---------------------------------------------------------------------------

/** GET /api/v1/accounts/health -- accounts with health status and tier info. */
export async function fetchAccountsHealth(
  token: string,
): Promise<import("./provider-health").AccountsHealthResponse> {
  return apiFetch<import("./provider-health").AccountsHealthResponse>(
    "/v1/accounts",
    { token },
  );
}

/** POST /api/v1/accounts/:id/reconnect -- trigger re-auth for an account. */
export async function reconnectAccount(
  token: string,
  accountId: string,
): Promise<{ redirect_url: string }> {
  return apiFetch<{ redirect_url: string }>(
    `/v1/accounts/${encodeURIComponent(accountId)}/reconnect`,
    { method: "POST", token },
  );
}

/** DELETE /api/v1/accounts/:id -- disconnect and clean up. */
export async function removeAccount(
  token: string,
  accountId: string,
): Promise<void> {
  return apiFetch<void>(
    `/v1/accounts/${encodeURIComponent(accountId)}`,
    { method: "DELETE", token },
  );
}

/** GET /api/v1/accounts/:id/sync-history -- recent sync events. */
export async function fetchSyncHistory(
  token: string,
  accountId: string,
): Promise<import("./provider-health").SyncHistoryResponse> {
  return apiFetch<import("./provider-health").SyncHistoryResponse>(
    `/v1/accounts/${encodeURIComponent(accountId)}/sync-history`,
    { token },
  );
}

/** GET /api/v1/accounts/:id/scopes -- list scoped calendars with capabilities. */
export async function fetchAccountScopes(
  token: string,
  accountId: string,
): Promise<AccountScopesResponse> {
  return apiFetch<AccountScopesResponse>(
    `/v1/accounts/${encodeURIComponent(accountId)}/scopes`,
    { token },
  );
}

/** PUT /api/v1/accounts/:id/scopes -- update scoped calendars. */
export async function updateAccountScopes(
  token: string,
  accountId: string,
  scopes: ScopeUpdateItem[],
): Promise<AccountScopesResponse> {
  return apiFetch<AccountScopesResponse>(
    `/v1/accounts/${encodeURIComponent(accountId)}/scopes`,
    { method: "PUT", body: { scopes }, token },
  );
}
