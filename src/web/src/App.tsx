/**
 * App root component.
 *
 * Architecture (TM-bjnt):
 * - React Router v7 (HashRouter) for declarative routing
 * - ApiProvider context for token-injected API functions
 * - ErrorBoundary at app root for crash recovery
 * - Token refresh via AuthProvider
 *
 * All pages now use useApi() internally (TM-hccd completed migration):
 * - Calendar, Accounts, SyncStatus (TM-wqip)
 * - Policies, ProviderHealth, ErrorRecovery (TM-b5g4)
 * - Billing, Scheduling, Governance (TM-6dgl)
 * - Relationships, Reconnections (TM-9xih)
 * - Admin, Onboarding (TM-hccd)
 *
 * No more legacy prop-passing route wrappers.
 */

import { lazy, Suspense } from "react";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import { ApiProvider } from "./lib/api-provider";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AppShell } from "./components/AppShell";

// ---------------------------------------------------------------------------
// Lazy-loaded page components (TM-w9ql: code-splitting to reduce bundle size)
// ---------------------------------------------------------------------------

const Login = lazy(() => import("./pages/Login").then((m) => ({ default: m.Login })));
const Calendar = lazy(() => import("./pages/Calendar").then((m) => ({ default: m.Calendar })));
const Accounts = lazy(() => import("./pages/Accounts").then((m) => ({ default: m.Accounts })));
const SyncStatus = lazy(() => import("./pages/SyncStatus").then((m) => ({ default: m.SyncStatus })));
const Policies = lazy(() => import("./pages/Policies").then((m) => ({ default: m.Policies })));
const ErrorRecovery = lazy(() => import("./pages/ErrorRecovery").then((m) => ({ default: m.ErrorRecovery })));
const Billing = lazy(() => import("./pages/Billing").then((m) => ({ default: m.Billing })));
const Scheduling = lazy(() => import("./pages/Scheduling").then((m) => ({ default: m.Scheduling })));
const Governance = lazy(() => import("./pages/Governance").then((m) => ({ default: m.Governance })));
const Relationships = lazy(() => import("./pages/Relationships").then((m) => ({ default: m.Relationships })));
const Reconnections = lazy(() => import("./pages/Reconnections").then((m) => ({ default: m.Reconnections })));
const Admin = lazy(() => import("./pages/Admin").then((m) => ({ default: m.Admin })));
const Onboarding = lazy(() => import("./pages/Onboarding").then((m) => ({ default: m.Onboarding })));
const ProviderHealth = lazy(() => import("./pages/ProviderHealth").then((m) => ({ default: m.ProviderHealth })));

// ---------------------------------------------------------------------------
// Suspense loading fallback
// ---------------------------------------------------------------------------

function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-[200px]">
      <span className="text-muted-foreground text-sm">Loading...</span>
    </div>
  );
}

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
// Default route handler
// ---------------------------------------------------------------------------

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
          <Route path="/admin/:orgId" element={<Admin />} />
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
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
                <Route path="/onboard" element={<RequireAuth><Onboarding /></RequireAuth>} />
                <Route path="/" element={<DefaultRoute />} />
                <Route path="/*" element={<AuthenticatedRoutes />} />
              </Routes>
            </Suspense>
          </HashRouter>
        </ApiProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
