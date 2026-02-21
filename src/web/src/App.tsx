/**
 * App root component.
 *
 * Architecture (TM-bjnt):
 * - React Router v7 (HashRouter) for declarative routing
 * - ApiProvider context for token-injected API functions
 * - ErrorBoundary at app root for crash recovery
 * - Token refresh via AuthProvider
 *
 * Pages migrated to useApi():
 * - Calendar, Accounts, SyncStatus (TM-wqip)
 * - Policies, ProviderHealth, ErrorRecovery (TM-b5g4)
 * - Billing, Scheduling, Governance (TM-6dgl)
 * - Relationships, Reconnections (TM-9xih)
 * Remaining pages still use legacy prop-passing via route wrappers.
 */

import { HashRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import { ApiProvider, useApi } from "./lib/api-provider";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AppShell } from "./components/AppShell";
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
import { useOnboardingCallbackId, useAdminTierGate } from "./lib/route-helpers";

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

/**
 * Wraps guest-only routes (e.g. /login). Redirects authenticated users
 * to /calendar so they cannot revisit the login page while logged in.
 */
function GuestOnly({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  if (token) return <Navigate to="/calendar" replace />;
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
// Authenticated routes wrapped in AppShell
// ---------------------------------------------------------------------------

function AuthenticatedRoutes() {
  return (
    <RequireAuth>
      <AppShell>
        <Routes>
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/sync-status" element={<SyncStatus />} />
          <Route path="/policies" element={<Policies />} />
          <Route path="/errors" element={<ErrorRecovery />} />
          <Route path="/billing" element={<Billing />} />
          <Route path="/scheduling" element={<Scheduling />} />
          <Route path="/governance" element={<Governance />} />
          <Route path="/relationships" element={<Relationships />} />
          <Route path="/reconnections" element={<Reconnections />} />
          <Route path="/provider-health" element={<ProviderHealth />} />
          <Route path="/admin/:orgId" element={<AdminRoute />} />
          <Route path="*" element={<Navigate to="/calendar" replace />} />
        </Routes>
      </AppShell>
    </RequireAuth>
  );
}

// ---------------------------------------------------------------------------
// App root
// ---------------------------------------------------------------------------

export function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <ApiProvider>
          <HashRouter>
            <Routes>
              <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
              <Route path="/onboard" element={<RequireAuth><OnboardingRoute /></RequireAuth>} />
              <Route path="/" element={<DefaultRoute />} />
              <Route path="/*" element={<AuthenticatedRoutes />} />
            </Routes>
          </HashRouter>
        </ApiProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
