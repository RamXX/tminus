/**
 * App root component.
 *
 * Simple hash-based router (no dependency needed for walking skeleton).
 * Routes:
 *   #/login       -> Login page
 *   #/calendar    -> Calendar page (requires auth)
 *   #/accounts    -> Account Management (requires auth)
 *   #/sync-status -> Sync Status Dashboard (requires auth)
 *   #/policies    -> Policy Management (requires auth)
 *   default       -> redirects to login or calendar based on auth state
 */

import { useState, useEffect, useCallback } from "react";
import { AuthProvider, useAuth } from "./lib/auth";
import { Login } from "./pages/Login";
import { Calendar } from "./pages/Calendar";
import { Accounts } from "./pages/Accounts";
import { SyncStatus } from "./pages/SyncStatus";
import { Policies } from "./pages/Policies";
import { fetchSyncStatus, fetchAccounts, unlinkAccount } from "./lib/api";
import { fetchPolicies, updatePolicyEdge } from "./lib/policies";

function Router() {
  const { token } = useAuth();
  const [route, setRoute] = useState(window.location.hash || "#/");

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
    case "#/calendar":
      return <Calendar />;
    case "#/accounts":
      return (
        <Accounts
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
    default:
      // Unknown route -- redirect to calendar if authenticated, login otherwise
      window.location.hash = token ? "#/calendar" : "#/login";
      return null;
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
