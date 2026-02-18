/**
 * App root component.
 *
 * Simple hash-based router (no dependency needed for walking skeleton).
 * Routes:
 *   #/login       -> Login page
 *   #/onboard     -> Onboarding page (requires auth)
 *   #/calendar    -> Calendar page (requires auth)
 *   #/accounts    -> Account Management (requires auth)
 *   #/sync-status -> Sync Status Dashboard (requires auth)
 *   #/policies    -> Policy Management (requires auth)
 *   #/errors      -> Error Recovery (requires auth)
 *   #/billing     -> Billing & Subscription (requires auth)
 *   #/scheduling  -> Scheduling Dashboard (requires auth)
 *   #/governance  -> Governance Dashboard (requires auth)
 *   #/relationships -> Relationships Dashboard (requires auth)
 *   #/reconnections -> Reconnections Dashboard (requires auth)
 *   #/admin/:orgId  -> Admin Console (requires auth + enterprise)
 *   default       -> redirects to login or calendar based on auth state
 */

import { useState, useEffect, useCallback } from "react";
import { AuthProvider, useAuth } from "./lib/auth";
import { Login } from "./pages/Login";
import { Calendar } from "./pages/Calendar";
import { Accounts } from "./pages/Accounts";
import { SyncStatus } from "./pages/SyncStatus";
import { Policies } from "./pages/Policies";
import { ErrorRecovery } from "./pages/ErrorRecovery";
import { Billing } from "./pages/Billing";
import { Scheduling } from "./pages/Scheduling";
import { Governance } from "./pages/Governance";
import { Relationships } from "./pages/Relationships";
import { Reconnections } from "./pages/Reconnections";
import { Admin } from "./pages/Admin";
import { Onboarding } from "./pages/Onboarding";
import { parseOAuthCallback } from "./lib/onboarding";
import type { OnboardingSyncStatus } from "./lib/onboarding";
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
} from "./lib/api";
import { fetchPolicies, updatePolicyEdge } from "./lib/policies";
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
} from "./lib/admin";

function Router() {
  const { token, user } = useAuth();
  const [route, setRoute] = useState(window.location.hash || "#/");
  const [accountsCount, setAccountsCount] = useState(0);
  const [userTier, setUserTier] = useState<string>("free");

  useEffect(() => {
    const handler = () => setRoute(window.location.hash || "#/");
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  // Bound fetch for sync status -- injects current token
  const boundFetchSyncStatus = useCallback(async () => {
    if (!token) throw new Error("Not authenticated");
    return fetchSyncStatus(token);
  }, [token]);

  // Bound fetch/update for policies -- injects current token
  const boundFetchPolicies = useCallback(async () => {
    if (!token) throw new Error("Not authenticated");
    return fetchPolicies(token);
  }, [token]);

  const boundUpdatePolicyEdge = useCallback(
    async (
      policyId: string,
      edge: {
        from_account_id: string;
        to_account_id: string;
        detail_level: "BUSY" | "TITLE" | "FULL";
      },
    ) => {
      if (!token) throw new Error("Not authenticated");
      return updatePolicyEdge(token, policyId, edge);
    },
    [token],
  );

  // Bound fetch/unlink for accounts -- injects current token
  const boundFetchAccounts = useCallback(async () => {
    if (!token) throw new Error("Not authenticated");
    return fetchAccounts(token);
  }, [token]);

  const boundUnlinkAccount = useCallback(
    async (accountId: string) => {
      if (!token) throw new Error("Not authenticated");
      return unlinkAccount(token, accountId);
    },
    [token],
  );

  // Bound fetch/retry for error recovery -- injects current token
  const boundFetchErrors = useCallback(async () => {
    if (!token) throw new Error("Not authenticated");
    return fetchErrorMirrors(token);
  }, [token]);

  const boundRetryMirror = useCallback(
    async (mirrorId: string) => {
      if (!token) throw new Error("Not authenticated");
      return retryMirror(token, mirrorId);
    },
    [token],
  );

  // Fetch accounts count for billing page usage display
  useEffect(() => {
    if (!token) return;
    const routePath = (window.location.hash || "#/").split("?")[0];
    if (routePath === "#/billing") {
      fetchAccounts(token).then(
        (accounts) => setAccountsCount(accounts.length),
        () => { /* non-critical */ },
      );
    }
  }, [token, route]);

  // Fetch billing tier for admin console enterprise gate
  useEffect(() => {
    if (!token) return;
    const routePath = (window.location.hash || "#/").split("?")[0];
    if (routePath.startsWith("#/admin/")) {
      fetchBillingStatus(token).then(
        (status) => setUserTier(status.tier),
        () => { /* non-critical -- defaults to "free" which blocks access */ },
      );
    }
  }, [token, route]);

  // Bound billing functions -- injects current token
  const boundFetchBillingStatus = useCallback(async () => {
    if (!token) throw new Error("Not authenticated");
    return fetchBillingStatus(token);
  }, [token]);

  const boundCreateCheckoutSession = useCallback(
    async (priceId: string) => {
      if (!token) throw new Error("Not authenticated");
      return createCheckoutSession(token, priceId);
    },
    [token],
  );

  const boundCreatePortalSession = useCallback(async () => {
    if (!token) throw new Error("Not authenticated");
    return createPortalSession(token);
  }, [token]);

  const boundFetchBillingHistory = useCallback(async () => {
    if (!token) throw new Error("Not authenticated");
    return fetchBillingHistory(token);
  }, [token]);

  // Bound scheduling functions -- injects current token
  const boundListSessions = useCallback(async () => {
    if (!token) throw new Error("Not authenticated");
    return listSessions(token);
  }, [token]);

  const boundCreateSchedulingSession = useCallback(
    async (payload: import("./lib/scheduling").CreateSessionPayload) => {
      if (!token) throw new Error("Not authenticated");
      return createSchedulingSession(token, payload);
    },
    [token],
  );

  const boundCommitCandidate = useCallback(
    async (sessionId: string, candidateId: string) => {
      if (!token) throw new Error("Not authenticated");
      return commitCandidate(token, sessionId, candidateId);
    },
    [token],
  );

  const boundCancelSession = useCallback(
    async (sessionId: string) => {
      if (!token) throw new Error("Not authenticated");
      return cancelSession(token, sessionId);
    },
    [token],
  );

  // Bound governance functions -- injects current token
  const boundFetchCommitments = useCallback(async () => {
    if (!token) throw new Error("Not authenticated");
    return fetchCommitments(token);
  }, [token]);

  const boundFetchVips = useCallback(async () => {
    if (!token) throw new Error("Not authenticated");
    return fetchVips(token);
  }, [token]);

  const boundAddVip = useCallback(
    async (payload: import("./lib/governance").AddVipPayload) => {
      if (!token) throw new Error("Not authenticated");
      return addVip(token, payload);
    },
    [token],
  );

  const boundRemoveVip = useCallback(
    async (vipId: string) => {
      if (!token) throw new Error("Not authenticated");
      return removeVip(token, vipId);
    },
    [token],
  );

  const boundExportProof = useCallback(
    async (commitmentId: string) => {
      if (!token) throw new Error("Not authenticated");
      return exportCommitmentProof(token, commitmentId);
    },
    [token],
  );

  // Bound relationship functions -- injects current token
  const boundFetchRelationships = useCallback(async () => {
    if (!token) throw new Error("Not authenticated");
    return fetchRelationships(token);
  }, [token]);

  const boundCreateRelationship = useCallback(
    async (payload: import("./lib/relationships").CreateRelationshipPayload) => {
      if (!token) throw new Error("Not authenticated");
      return createRelationship(token, payload);
    },
    [token],
  );

  const boundFetchRelationship = useCallback(
    async (id: string) => {
      if (!token) throw new Error("Not authenticated");
      return fetchRelationship(token, id);
    },
    [token],
  );

  const boundUpdateRelationship = useCallback(
    async (id: string, payload: import("./lib/relationships").UpdateRelationshipPayload) => {
      if (!token) throw new Error("Not authenticated");
      return updateRelationship(token, id, payload);
    },
    [token],
  );

  const boundDeleteRelationship = useCallback(
    async (id: string) => {
      if (!token) throw new Error("Not authenticated");
      return deleteRelationship(token, id);
    },
    [token],
  );

  const boundFetchReputation = useCallback(
    async (id: string) => {
      if (!token) throw new Error("Not authenticated");
      return fetchReputation(token, id);
    },
    [token],
  );

  const boundFetchOutcomes = useCallback(
    async (relationshipId: string) => {
      if (!token) throw new Error("Not authenticated");
      return fetchOutcomes(token, relationshipId);
    },
    [token],
  );

  const boundCreateOutcome = useCallback(
    async (relationshipId: string, payload: import("./lib/relationships").CreateOutcomePayload) => {
      if (!token) throw new Error("Not authenticated");
      return createOutcome(token, relationshipId, payload);
    },
    [token],
  );

  const boundFetchDriftReport = useCallback(async () => {
    if (!token) throw new Error("Not authenticated");
    return fetchDriftReport(token);
  }, [token]);

  // Bound reconnection functions -- injects current token
  const boundFetchReconnectionSuggestions = useCallback(async () => {
    if (!token) throw new Error("Not authenticated");
    return fetchReconnectionSuggestionsFull(token);
  }, [token]);

  const boundFetchUpcomingMilestones = useCallback(async () => {
    if (!token) throw new Error("Not authenticated");
    return fetchUpcomingMilestones(token);
  }, [token]);

  // Bound admin console functions -- injects current token
  const boundFetchOrgDetails = useCallback(
    async (orgId: string) => {
      if (!token) throw new Error("Not authenticated");
      return fetchOrgDetails(token, orgId);
    },
    [token],
  );

  const boundFetchOrgMembers = useCallback(
    async (orgId: string) => {
      if (!token) throw new Error("Not authenticated");
      return fetchOrgMembers(token, orgId);
    },
    [token],
  );

  const boundAddOrgMember = useCallback(
    async (orgId: string, userId: string, role: import("./lib/admin").OrgRole) => {
      if (!token) throw new Error("Not authenticated");
      await addOrgMember(token, orgId, { user_id: userId, role });
    },
    [token],
  );

  const boundRemoveOrgMember = useCallback(
    async (orgId: string, userId: string) => {
      if (!token) throw new Error("Not authenticated");
      await removeOrgMember(token, orgId, userId);
    },
    [token],
  );

  const boundChangeOrgMemberRole = useCallback(
    async (orgId: string, userId: string, role: import("./lib/admin").OrgRole) => {
      if (!token) throw new Error("Not authenticated");
      await changeOrgMemberRole(token, orgId, userId, { role });
    },
    [token],
  );

  const boundFetchOrgPolicies = useCallback(
    async (orgId: string) => {
      if (!token) throw new Error("Not authenticated");
      return fetchOrgPolicies(token, orgId);
    },
    [token],
  );

  const boundCreateOrgPolicy = useCallback(
    async (orgId: string, payload: import("./lib/admin").CreatePolicyPayload) => {
      if (!token) throw new Error("Not authenticated");
      await createOrgPolicy(token, orgId, payload);
    },
    [token],
  );

  const boundUpdateOrgPolicy = useCallback(
    async (orgId: string, policyId: string, payload: import("./lib/admin").UpdatePolicyPayload) => {
      if (!token) throw new Error("Not authenticated");
      await updateOrgPolicy(token, orgId, policyId, payload);
    },
    [token],
  );

  const boundDeleteOrgPolicy = useCallback(
    async (orgId: string, policyId: string) => {
      if (!token) throw new Error("Not authenticated");
      await deleteOrgPolicy(token, orgId, policyId);
    },
    [token],
  );

  const boundFetchOrgUsage = useCallback(
    async (orgId: string) => {
      if (!token) throw new Error("Not authenticated");
      return fetchOrgUsage(token, orgId);
    },
    [token],
  );

  // Bound onboarding functions -- injects current token
  const boundFetchAccountStatus = useCallback(
    async (accountId: string): Promise<OnboardingSyncStatus> => {
      if (!token) throw new Error("Not authenticated");
      const detail = await fetchAccountDetail(token, accountId);
      return {
        account_id: detail.account_id,
        email: detail.email,
        provider: detail.provider,
        status: detail.status,
        health: detail.health,
      };
    },
    [token],
  );

  const boundFetchEventsForOnboarding = useCallback(async () => {
    if (!token) throw new Error("Not authenticated");
    return fetchEvents(token);
  }, [token]);

  const boundSubmitAppleCredentials = useCallback(
    async (userId: string, email: string, password: string) => {
      if (!token) throw new Error("Not authenticated");
      // POST to the API to create an Apple calendar account with app-specific password
      const result = await apiFetch<{ account_id: string }>(
        "/v1/accounts/apple",
        { method: "POST", body: { user_id: userId, email, password }, token },
      );
      return result;
    },
    [token],
  );

  // Parse OAuth callback params from hash URL (e.g., #/onboard?account_id=acc-123)
  const onboardCallbackAccountId = (() => {
    if (!route.startsWith("#/onboard")) return null;
    const { accountId } = parseOAuthCallback(
      `${window.location.origin}${window.location.pathname}${route}`,
    );
    return accountId;
  })();

  // Redirect logic based on auth state
  if (!token && route !== "#/login") {
    window.location.hash = "#/login";
    return null;
  }

  if (token && (route === "#/login" || route === "#/")) {
    window.location.hash = "#/calendar";
    return null;
  }

  // Route matching: strip query params for switch but keep them in hash
  // for OAuth callback handling (e.g., #/accounts?linked=true)
  const routePath = route.split("?")[0];

  switch (routePath) {
    case "#/login":
      return <Login />;
    case "#/onboard":
      return user ? (
        <Onboarding
          user={user}
          fetchAccountStatus={boundFetchAccountStatus}
          fetchEvents={boundFetchEventsForOnboarding}
          callbackAccountId={onboardCallbackAccountId}
          submitAppleCredentials={boundSubmitAppleCredentials}
        />
      ) : null;
    case "#/calendar":
      return <Calendar />;
    case "#/accounts":
      return (
        <Accounts
          currentUserId={user?.id ?? ""}
          fetchAccounts={boundFetchAccounts}
          unlinkAccount={boundUnlinkAccount}
        />
      );
    case "#/sync-status":
      return <SyncStatus fetchSyncStatus={boundFetchSyncStatus} />;
    case "#/policies":
      return (
        <Policies
          fetchPolicies={boundFetchPolicies}
          updatePolicyEdge={boundUpdatePolicyEdge}
        />
      );
    case "#/errors":
      return (
        <ErrorRecovery
          fetchErrors={boundFetchErrors}
          retryMirror={boundRetryMirror}
        />
      );
    case "#/billing":
      return (
        <Billing
          fetchBillingStatus={boundFetchBillingStatus}
          createCheckoutSession={boundCreateCheckoutSession}
          createPortalSession={boundCreatePortalSession}
          fetchBillingHistory={boundFetchBillingHistory}
          accountsUsed={accountsCount}
        />
      );
    case "#/scheduling":
      return (
        <Scheduling
          listSessions={boundListSessions}
          fetchAccounts={boundFetchAccounts}
          createSession={boundCreateSchedulingSession}
          commitCandidate={boundCommitCandidate}
          cancelSession={boundCancelSession}
        />
      );
    case "#/governance":
      return (
        <Governance
          fetchCommitments={boundFetchCommitments}
          fetchVips={boundFetchVips}
          addVip={boundAddVip}
          removeVip={boundRemoveVip}
          exportProof={boundExportProof}
        />
      );
    case "#/relationships":
      return (
        <Relationships
          fetchRelationships={boundFetchRelationships}
          createRelationship={boundCreateRelationship}
          fetchRelationship={boundFetchRelationship}
          updateRelationship={boundUpdateRelationship}
          deleteRelationship={boundDeleteRelationship}
          fetchReputation={boundFetchReputation}
          fetchOutcomes={boundFetchOutcomes}
          createOutcome={boundCreateOutcome}
          fetchDriftReport={boundFetchDriftReport}
        />
      );
    case "#/reconnections":
      return (
        <Reconnections
          fetchReconnectionSuggestions={boundFetchReconnectionSuggestions}
          fetchUpcomingMilestones={boundFetchUpcomingMilestones}
        />
      );
    default: {
      // Dynamic route: #/admin/:orgId
      if (routePath.startsWith("#/admin/")) {
        const adminOrgId = decodeURIComponent(routePath.replace("#/admin/", ""));
        if (adminOrgId && user) {
          return (
            <Admin
              orgId={adminOrgId}
              currentUserId={user.id}
              userTier={userTier}
              fetchOrgDetails={boundFetchOrgDetails}
              fetchOrgMembers={boundFetchOrgMembers}
              addOrgMember={boundAddOrgMember}
              removeOrgMember={boundRemoveOrgMember}
              changeOrgMemberRole={boundChangeOrgMemberRole}
              fetchOrgPolicies={boundFetchOrgPolicies}
              createOrgPolicy={boundCreateOrgPolicy}
              updateOrgPolicy={boundUpdateOrgPolicy}
              deleteOrgPolicy={boundDeleteOrgPolicy}
              fetchOrgUsage={boundFetchOrgUsage}
            />
          );
        }
      }
      // Unknown route -- redirect to calendar if authenticated, login otherwise
      window.location.hash = token ? "#/calendar" : "#/login";
      return null;
    }
  }
}

export function App() {
  return (
    <AuthProvider>
      <div style={{ minHeight: "100vh", padding: "1rem" }}>
        <Router />
      </div>
    </AuthProvider>
  );
}
