/**
 * ApiProvider context for the T-Minus SPA.
 *
 * Provides token-injected API functions via React context so that pages
 * can call `const api = useApi()` instead of receiving callback props.
 *
 * This replaces the 40+ useCallback bindings in the old App.tsx Router
 * component. All API functions automatically inject the current JWT token
 * from the auth context.
 *
 * Both patterns coexist during migration:
 * - Old: pages receive bound callbacks as props from the Router
 * - New: pages call `useApi()` to get the same functions
 *
 * After migration (TM-02x1), the prop-passing pattern will be removed.
 */

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useAuth } from "./auth";

// ---------------------------------------------------------------------------
// API imports
// ---------------------------------------------------------------------------

import {
  apiFetch,
  fetchSyncStatus,
  fetchAccounts,
  fetchAccountDetail,
  fetchEvents,
  unlinkAccount,
  fetchErrorMirrors,
  retryMirror,
  fetchBillingStatus,
  createCheckoutSession,
  createPortalSession,
  fetchBillingHistory,
  createSchedulingSession,
  listSessions,
  commitCandidate,
  cancelSession,
  fetchCommitments,
  fetchVips,
  addVip,
  removeVip,
  exportCommitmentProof,
  fetchRelationships,
  createRelationship,
  fetchRelationship,
  updateRelationship,
  deleteRelationship,
  fetchReputation,
  fetchOutcomes,
  createOutcome,
  fetchDriftReport,
  fetchReconnectionSuggestionsFull,
  fetchUpcomingMilestones,
  fetchAccountsHealth,
  reconnectAccount,
  removeAccount,
  fetchSyncHistory,
  fetchEventBriefing,
  generateExcuse,
  createEvent,
  updateEvent,
  deleteEvent,
  createOnboardingSession,
  getOnboardingSession,
  getOnboardingStatus,
  addOnboardingAccount,
  completeOnboardingSession,
  fetchAccountScopes,
  updateAccountScopes,
} from "./api";
import { fetchPolicies, updatePolicyEdge } from "./policies";
import {
  fetchOrgDetails,
  fetchOrgMembers,
  addOrgMember,
  removeOrgMember,
  changeOrgMemberRole,
  fetchOrgPolicies,
  createOrgPolicy,
  updateOrgPolicy,
  deleteOrgPolicy,
  fetchOrgUsage,
} from "./admin";

// Re-export types for consumers
import type { OnboardingSyncStatus } from "./onboarding";
import type { CreateSessionPayload } from "./scheduling";
import type { AddVipPayload } from "./governance";
import type {
  CreateRelationshipPayload,
  UpdateRelationshipPayload,
  CreateOutcomePayload,
} from "./relationships";
import type { OrgRole, CreatePolicyPayload, UpdatePolicyPayload } from "./admin";
import type { DetailLevel } from "./policies";
import type { ExcuseTone, TruthLevel } from "./briefing";
import type { CreateEventPayload, UpdateEventPayload, AccountScopesResponse, ScopeUpdateItem } from "./api";

// ---------------------------------------------------------------------------
// Context value type
// ---------------------------------------------------------------------------

export interface ApiContextValue {
  // Sync status
  fetchSyncStatus: () => Promise<import("./sync-status").SyncStatusResponse>;

  // Policies
  fetchPolicies: () => Promise<import("./policies").PolicyMatrixData>;
  updatePolicyEdge: (
    policyId: string,
    edge: { from_account_id: string; to_account_id: string; detail_level: DetailLevel },
  ) => Promise<import("./policies").PolicyEdgeData>;

  // Accounts
  fetchAccounts: () => Promise<import("./api").LinkedAccount[]>;
  unlinkAccount: (accountId: string) => Promise<void>;
  fetchScopes: (accountId: string) => Promise<AccountScopesResponse>;
  updateScopes: (accountId: string, scopes: ScopeUpdateItem[]) => Promise<AccountScopesResponse>;

  // Error recovery
  fetchErrors: () => Promise<import("./error-recovery").ErrorMirror[]>;
  retryMirror: (mirrorId: string) => Promise<import("./error-recovery").RetryResult>;

  // Billing
  fetchBillingStatus: () => Promise<import("./billing").BillingStatusResponse>;
  createCheckoutSession: (priceId: string) => Promise<import("./billing").CheckoutResponse>;
  createPortalSession: () => Promise<import("./billing").PortalResponse>;
  fetchBillingHistory: () => Promise<import("./billing").BillingEvent[]>;

  // Scheduling
  listSessions: () => Promise<import("./scheduling").SchedulingSession[]>;
  createSchedulingSession: (payload: CreateSessionPayload) => Promise<import("./scheduling").SchedulingSession>;
  commitCandidate: (sessionId: string, candidateId: string) => Promise<import("./scheduling").CommitResponse>;
  cancelSession: (sessionId: string) => Promise<import("./scheduling").CancelResponse>;

  // Governance
  fetchCommitments: () => Promise<import("./governance").Commitment[]>;
  fetchVips: () => Promise<import("./governance").VipContact[]>;
  addVip: (payload: AddVipPayload) => Promise<import("./governance").VipContact>;
  removeVip: (vipId: string) => Promise<void>;
  exportProof: (commitmentId: string) => Promise<import("./governance").ExportProofResponse>;

  // Relationships
  fetchRelationships: () => Promise<import("./relationships").Relationship[]>;
  createRelationship: (payload: CreateRelationshipPayload) => Promise<import("./relationships").Relationship>;
  fetchRelationship: (id: string) => Promise<import("./relationships").Relationship>;
  updateRelationship: (id: string, payload: UpdateRelationshipPayload) => Promise<import("./relationships").Relationship>;
  deleteRelationship: (id: string) => Promise<void>;
  fetchReputation: (id: string) => Promise<import("./relationships").ReputationScores>;
  fetchOutcomes: (relationshipId: string) => Promise<import("./relationships").Outcome[]>;
  createOutcome: (relationshipId: string, payload: CreateOutcomePayload) => Promise<import("./relationships").Outcome>;
  fetchDriftReport: () => Promise<import("./relationships").DriftReport>;

  // Reconnections
  fetchReconnectionSuggestions: () => Promise<import("./reconnections").ReconnectionSuggestionFull[]>;
  fetchUpcomingMilestones: () => Promise<import("./reconnections").UpcomingMilestone[]>;

  // Admin
  fetchOrgDetails: (orgId: string) => Promise<import("./admin").OrgDetails>;
  fetchOrgMembers: (orgId: string) => Promise<import("./admin").OrgMember[]>;
  addOrgMember: (orgId: string, userId: string, role: OrgRole) => Promise<void>;
  removeOrgMember: (orgId: string, userId: string) => Promise<void>;
  changeOrgMemberRole: (orgId: string, userId: string, role: OrgRole) => Promise<void>;
  fetchOrgPolicies: (orgId: string) => Promise<import("./admin").OrgPolicy[]>;
  createOrgPolicy: (orgId: string, payload: CreatePolicyPayload) => Promise<void>;
  updateOrgPolicy: (orgId: string, policyId: string, payload: UpdatePolicyPayload) => Promise<void>;
  deleteOrgPolicy: (orgId: string, policyId: string) => Promise<void>;
  fetchOrgUsage: (orgId: string) => Promise<import("./admin").MemberUsage[]>;

  // Onboarding
  fetchAccountStatus: (accountId: string) => Promise<OnboardingSyncStatus>;
  fetchEventsForOnboarding: () => Promise<import("./api").CalendarEvent[]>;
  submitAppleCredentials: (userId: string, email: string, password: string) => Promise<{ account_id: string }>;

  // Provider health
  fetchAccountsHealth: () => Promise<import("./provider-health").AccountsHealthResponse>;
  fetchSyncHistory: (accountId: string) => Promise<import("./provider-health").SyncHistoryResponse>;
  reconnectAccount: (accountId: string) => Promise<void>;
  removeAccount: (accountId: string) => Promise<void>;

  // Calendar (events, briefing, excuse)
  fetchEventsFull: (params?: { start?: string; end?: string }) => Promise<import("./api").CalendarEvent[]>;
  createEvent: (payload: CreateEventPayload) => Promise<import("./api").CalendarEvent>;
  updateEvent: (eventId: string, payload: UpdateEventPayload) => Promise<import("./api").CalendarEvent>;
  deleteEvent: (eventId: string) => Promise<void>;
  fetchEventBriefing: (eventId: string) => Promise<import("./briefing").EventBriefing>;
  generateExcuse: (eventId: string, params: { tone: ExcuseTone; truth_level: TruthLevel }) => Promise<import("./briefing").ExcuseOutput>;

  // Onboarding session management
  createOnboardingSession: () => Promise<import("./onboarding-session").OnboardingSession>;
  getOnboardingSession: () => Promise<import("./onboarding-session").OnboardingSession | null>;
  getOnboardingStatus: () => Promise<{
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
  }>;
  addOnboardingAccount: (payload: {
    account_id: string;
    provider: string;
    email: string;
    calendar_count?: number;
  }) => Promise<void>;
  completeOnboardingSession: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ApiContext = createContext<ApiContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ApiProvider({ children }: { children: ReactNode }) {
  const { token } = useAuth();

  // Helper: ensures token is present before making an API call.
  // This replaces the `if (!token) throw new Error("Not authenticated")`
  // pattern repeated in every useCallback in the old App.tsx.
  function requireToken(): string {
    if (!token) throw new Error("Not authenticated");
    return token;
  }

  const value = useMemo<ApiContextValue>(() => ({
    // Sync status
    fetchSyncStatus: () => fetchSyncStatus(requireToken()),

    // Policies
    fetchPolicies: () => fetchPolicies(requireToken()),
    updatePolicyEdge: (policyId, edge) => updatePolicyEdge(requireToken(), policyId, edge),

    // Accounts
    fetchAccounts: () => fetchAccounts(requireToken()),
    unlinkAccount: (accountId) => unlinkAccount(requireToken(), accountId),
    fetchScopes: (accountId) => fetchAccountScopes(requireToken(), accountId),
    updateScopes: (accountId, scopeItems) => updateAccountScopes(requireToken(), accountId, scopeItems),

    // Error recovery
    fetchErrors: () => fetchErrorMirrors(requireToken()),
    retryMirror: (mirrorId) => retryMirror(requireToken(), mirrorId),

    // Billing
    fetchBillingStatus: () => fetchBillingStatus(requireToken()),
    createCheckoutSession: (priceId) => createCheckoutSession(requireToken(), priceId),
    createPortalSession: () => createPortalSession(requireToken()),
    fetchBillingHistory: () => fetchBillingHistory(requireToken()),

    // Scheduling
    listSessions: () => listSessions(requireToken()),
    createSchedulingSession: (payload) => createSchedulingSession(requireToken(), payload),
    commitCandidate: (sessionId, candidateId) => commitCandidate(requireToken(), sessionId, candidateId),
    cancelSession: (sessionId) => cancelSession(requireToken(), sessionId),

    // Governance
    fetchCommitments: () => fetchCommitments(requireToken()),
    fetchVips: () => fetchVips(requireToken()),
    addVip: (payload) => addVip(requireToken(), payload),
    removeVip: (vipId) => removeVip(requireToken(), vipId),
    exportProof: (commitmentId) => exportCommitmentProof(requireToken(), commitmentId),

    // Relationships
    fetchRelationships: () => fetchRelationships(requireToken()),
    createRelationship: (payload) => createRelationship(requireToken(), payload),
    fetchRelationship: (id) => fetchRelationship(requireToken(), id),
    updateRelationship: (id, payload) => updateRelationship(requireToken(), id, payload),
    deleteRelationship: (id) => deleteRelationship(requireToken(), id),
    fetchReputation: (id) => fetchReputation(requireToken(), id),
    fetchOutcomes: (relationshipId) => fetchOutcomes(requireToken(), relationshipId),
    createOutcome: (relationshipId, payload) => createOutcome(requireToken(), relationshipId, payload),
    fetchDriftReport: () => fetchDriftReport(requireToken()),

    // Reconnections
    fetchReconnectionSuggestions: () => fetchReconnectionSuggestionsFull(requireToken()),
    fetchUpcomingMilestones: () => fetchUpcomingMilestones(requireToken()),

    // Admin
    fetchOrgDetails: (orgId) => fetchOrgDetails(requireToken(), orgId),
    fetchOrgMembers: (orgId) => fetchOrgMembers(requireToken(), orgId),
    addOrgMember: async (orgId, userId, role) => { await addOrgMember(requireToken(), orgId, { user_id: userId, role }); },
    removeOrgMember: async (orgId, userId) => { await removeOrgMember(requireToken(), orgId, userId); },
    changeOrgMemberRole: async (orgId, userId, role) => { await changeOrgMemberRole(requireToken(), orgId, userId, { role }); },
    fetchOrgPolicies: (orgId) => fetchOrgPolicies(requireToken(), orgId),
    createOrgPolicy: async (orgId, payload) => { await createOrgPolicy(requireToken(), orgId, payload); },
    updateOrgPolicy: async (orgId, policyId, payload) => { await updateOrgPolicy(requireToken(), orgId, policyId, payload); },
    deleteOrgPolicy: async (orgId, policyId) => { await deleteOrgPolicy(requireToken(), orgId, policyId); },
    fetchOrgUsage: (orgId) => fetchOrgUsage(requireToken(), orgId),

    // Onboarding
    fetchAccountStatus: async (accountId) => {
      const t = requireToken();
      const detail = await fetchAccountDetail(t, accountId);
      return {
        account_id: detail.account_id,
        email: detail.email,
        provider: detail.provider,
        status: detail.status,
        health: detail.health,
      };
    },
    fetchEventsForOnboarding: () => fetchEvents(requireToken()),
    submitAppleCredentials: (userId, email, password) =>
      apiFetch<{ account_id: string }>(
        "/v1/accounts/apple",
        { method: "POST", body: { user_id: userId, email, password }, token: requireToken() },
      ),

    // Provider health
    fetchAccountsHealth: () => fetchAccountsHealth(requireToken()),
    fetchSyncHistory: (accountId) => fetchSyncHistory(requireToken(), accountId),
    reconnectAccount: async (accountId) => {
      await reconnectAccount(requireToken(), accountId);
    },
    removeAccount: (accountId) => removeAccount(requireToken(), accountId),

    // Calendar
    fetchEventsFull: (params?) => fetchEvents(requireToken(), params),
    createEvent: (payload) => createEvent(requireToken(), payload),
    updateEvent: (eventId, payload) => updateEvent(requireToken(), eventId, payload),
    deleteEvent: (eventId) => deleteEvent(requireToken(), eventId),
    fetchEventBriefing: (eventId) => fetchEventBriefing(requireToken(), eventId),
    generateExcuse: (eventId, params) => generateExcuse(requireToken(), eventId, params),

    // Onboarding session management
    createOnboardingSession: () => createOnboardingSession(requireToken()),
    getOnboardingSession: () => getOnboardingSession(requireToken()),
    getOnboardingStatus: () => getOnboardingStatus(requireToken()),
    addOnboardingAccount: (payload) => addOnboardingAccount(requireToken(), payload),
    completeOnboardingSession: () => completeOnboardingSession(requireToken()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [token]);

  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Access token-injected API functions.
 *
 * Must be used within an ApiProvider (which itself must be within an AuthProvider).
 *
 * Usage:
 *   const api = useApi();
 *   const accounts = await api.fetchAccounts();
 */
export function useApi(): ApiContextValue {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error("useApi must be used within ApiProvider");
  return ctx;
}
