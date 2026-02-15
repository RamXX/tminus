/**
 * App root component.
 *
 * Simple hash-based router (no dependency needed for walking skeleton).
 * Routes:
 *   #/login       -> Login page
 *   #/calendar    -> Calendar page (requires auth)
 *   #/sync-status -> Sync Status Dashboard (requires auth)
 *   default       -> redirects to login or calendar based on auth state
 */

import { useState, useEffect, useCallback } from "react";
import { AuthProvider, useAuth } from "./lib/auth";
import { Login } from "./pages/Login";
import { Calendar } from "./pages/Calendar";
import { SyncStatus } from "./pages/SyncStatus";
import { fetchSyncStatus } from "./lib/api";

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

  // Redirect logic based on auth state
  if (!token && route !== "#/login") {
    window.location.hash = "#/login";
    return null;
  }

  if (token && (route === "#/login" || route === "#/")) {
    window.location.hash = "#/calendar";
    return null;
  }

  switch (route) {
    case "#/login":
      return <Login />;
    case "#/calendar":
      return <Calendar />;
    case "#/sync-status":
      return <SyncStatus fetchSyncStatus={boundFetchSyncStatus} />;
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
