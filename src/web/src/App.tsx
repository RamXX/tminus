/**
 * App root component.
 *
 * Architecture (TM-bjnt):
 * - React Router v7 (HashRouter) for declarative routing
 * - ApiProvider context for token-injected API functions
 * - ErrorBoundary at app root for crash recovery
 * - Token refresh via AuthProvider
 *
 * Both prop-passing (legacy) and useApi() (new) patterns coexist.
 * Pages will be migrated to useApi() in TM-02x1.
 */

import { HashRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import { ApiProvider, useApi } from "./lib/api-provider";
import { ErrorBoundary } from "./components/ErrorBoundary";
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
import { ProviderHealth } from "./pages/ProviderHealth";
import { useOnboardingCallbackId, useBillingAccountsCount, useAdminTierGate } from "./lib/route-helpers";

// ---------------------------------------------------------------------------
// Auth-aware route wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps authenticated routes. Redirects to /login when no token is present.
 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Page wrappers -- bridge legacy props to ApiProvider
// ---------------------------------------------------------------------------

function OnboardingRoute() {
  const { user } = useAuth();
  const api = useApi();
  const callbackAccountId = useOnboardingCallbackId();
  if (!user) return null;
  return (
    <Onboarding
      user={user}
      fetchAccountStatus={api.fetchAccountStatus}
      fetchEvents={api.fetchEventsForOnboarding}
      callbackAccountId={callbackAccountId}
      submitAppleCredentials={api.submitAppleCredentials}
    />
  );
}

function AccountsRoute() {
  const { user } = useAuth();
  const api = useApi();
  return (
    <Accounts
      currentUserId={user?.id ?? ""}
      fetchAccounts={api.fetchAccounts}
      unlinkAccount={api.unlinkAccount}
    />
  );
}

function SyncStatusRoute() {
  const api = useApi();
  return <SyncStatus fetchSyncStatus={api.fetchSyncStatus} />;
}

function PoliciesRoute() {
  const api = useApi();
  return (
    <Policies
      fetchPolicies={api.fetchPolicies}
      updatePolicyEdge={api.updatePolicyEdge}
    />
  );
}

function ErrorRecoveryRoute() {
  const api = useApi();
  return (
    <ErrorRecovery
      fetchErrors={api.fetchErrors}
      retryMirror={api.retryMirror}
    />
  );
}

function BillingRoute() {
  const api = useApi();
  const accountsCount = useBillingAccountsCount(api.fetchAccounts);
  return (
    <Billing
      fetchBillingStatus={api.fetchBillingStatus}
      createCheckoutSession={api.createCheckoutSession}
      createPortalSession={api.createPortalSession}
      fetchBillingHistory={api.fetchBillingHistory}
      accountsUsed={accountsCount}
    />
  );
}

function SchedulingRoute() {
  const api = useApi();
  return (
    <Scheduling
      listSessions={api.listSessions}
      fetchAccounts={api.fetchAccounts}
      createSession={api.createSchedulingSession}
      commitCandidate={api.commitCandidate}
      cancelSession={api.cancelSession}
    />
  );
}

function GovernanceRoute() {
  const api = useApi();
  return (
    <Governance
      fetchCommitments={api.fetchCommitments}
      fetchVips={api.fetchVips}
      addVip={api.addVip}
      removeVip={api.removeVip}
      exportProof={api.exportProof}
    />
  );
}

function RelationshipsRoute() {
  const api = useApi();
  return (
    <Relationships
      fetchRelationships={api.fetchRelationships}
      createRelationship={api.createRelationship}
      fetchRelationship={api.fetchRelationship}
      updateRelationship={api.updateRelationship}
      deleteRelationship={api.deleteRelationship}
      fetchReputation={api.fetchReputation}
      fetchOutcomes={api.fetchOutcomes}
      createOutcome={api.createOutcome}
      fetchDriftReport={api.fetchDriftReport}
    />
  );
}

function ReconnectionsRoute() {
  const api = useApi();
  return (
    <Reconnections
      fetchReconnectionSuggestions={api.fetchReconnectionSuggestions}
      fetchUpcomingMilestones={api.fetchUpcomingMilestones}
    />
  );
}

function ProviderHealthRoute() {
  const api = useApi();
  return (
    <ProviderHealth
      fetchAccountsHealth={api.fetchAccountsHealth}
      fetchSyncHistory={api.fetchSyncHistory}
      reconnectAccount={api.reconnectAccount}
      removeAccount={api.removeAccount}
    />
  );
}

function AdminRoute() {
  const { orgId } = useParams<{ orgId: string }>();
  const { user } = useAuth();
  const api = useApi();
  const userTier = useAdminTierGate(api.fetchBillingStatus);
  if (!orgId || !user) return <Navigate to="/calendar" replace />;
  return (
    <Admin
      orgId={orgId}
      currentUserId={user.id}
      userTier={userTier}
      fetchOrgDetails={api.fetchOrgDetails}
      fetchOrgMembers={api.fetchOrgMembers}
      addOrgMember={api.addOrgMember}
      removeOrgMember={api.removeOrgMember}
      changeOrgMemberRole={api.changeOrgMemberRole}
      fetchOrgPolicies={api.fetchOrgPolicies}
      createOrgPolicy={api.createOrgPolicy}
      updateOrgPolicy={api.updateOrgPolicy}
      deleteOrgPolicy={api.deleteOrgPolicy}
      fetchOrgUsage={api.fetchOrgUsage}
    />
  );
}

/**
 * Handles the default route: redirects authenticated users to /calendar
 * (or /accounts?linked=true on OAuth completion), unauthenticated to /login.
 */
function DefaultRoute() {
  const { token } = useAuth();
  const hasOAuthCompletionParams = new URL(window.location.href).searchParams.has("account_id");
  if (!token) return <Navigate to="/login" replace />;
  if (hasOAuthCompletionParams) return <Navigate to="/accounts?linked=true" replace />;
  return <Navigate to="/calendar" replace />;
}

// ---------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------

export function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <ApiProvider>
          <HashRouter>
            <div style={{ minHeight: "100vh", padding: "1rem" }}>
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/onboard" element={<RequireAuth><OnboardingRoute /></RequireAuth>} />
                <Route path="/calendar" element={<RequireAuth><Calendar /></RequireAuth>} />
                <Route path="/accounts" element={<RequireAuth><AccountsRoute /></RequireAuth>} />
                <Route path="/sync-status" element={<RequireAuth><SyncStatusRoute /></RequireAuth>} />
                <Route path="/policies" element={<RequireAuth><PoliciesRoute /></RequireAuth>} />
                <Route path="/errors" element={<RequireAuth><ErrorRecoveryRoute /></RequireAuth>} />
                <Route path="/billing" element={<RequireAuth><BillingRoute /></RequireAuth>} />
                <Route path="/scheduling" element={<RequireAuth><SchedulingRoute /></RequireAuth>} />
                <Route path="/governance" element={<RequireAuth><GovernanceRoute /></RequireAuth>} />
                <Route path="/relationships" element={<RequireAuth><RelationshipsRoute /></RequireAuth>} />
                <Route path="/reconnections" element={<RequireAuth><ReconnectionsRoute /></RequireAuth>} />
                <Route path="/provider-health" element={<RequireAuth><ProviderHealthRoute /></RequireAuth>} />
                <Route path="/admin/:orgId" element={<RequireAuth><AdminRoute /></RequireAuth>} />
                <Route path="/" element={<DefaultRoute />} />
                <Route path="*" element={<DefaultRoute />} />
              </Routes>
            </div>
          </HashRouter>
        </ApiProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
