/**
 * Route helper hooks for App.tsx.
 *
 * Extracts side-effect-heavy logic (OAuth callback parsing, billing account
 * count fetching, admin tier gating) out of the route components into
 * small, focused hooks.
 */

import { useState, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { parseOAuthCallback } from "./onboarding";

// ---------------------------------------------------------------------------
// Onboarding callback
// ---------------------------------------------------------------------------

/**
 * Parse the onboarding OAuth callback account_id from the current location.
 * Returns the account ID if present in the query params, null otherwise.
 */
export function useOnboardingCallbackId(): string | null {
  const location = useLocation();

  if (!location.pathname.startsWith("/onboard")) return null;

  // Build a full URL so parseOAuthCallback can extract the account_id
  const fakeUrl = `${window.location.origin}${window.location.pathname}#${location.pathname}${location.search}`;
  const { accountId } = parseOAuthCallback(fakeUrl);
  return accountId;
}

// ---------------------------------------------------------------------------
// Billing accounts count
// ---------------------------------------------------------------------------

/**
 * Fetch the linked accounts count for the billing page usage display.
 * Non-critical -- defaults to 0 on failure.
 */
export function useBillingAccountsCount(
  fetchAccounts: () => Promise<unknown[]>,
): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    fetchAccounts().then(
      (accounts) => setCount(accounts.length),
      () => { /* non-critical */ },
    );
  }, [fetchAccounts]);

  return count;
}

// ---------------------------------------------------------------------------
// Admin tier gate
// ---------------------------------------------------------------------------

/**
 * Fetch the user's billing tier for admin console enterprise gate.
 * Non-critical -- defaults to "free" which blocks access.
 */
export function useAdminTierGate(
  fetchBillingStatus: () => Promise<{ tier: string }>,
): string {
  const [tier, setTier] = useState("free");

  useEffect(() => {
    fetchBillingStatus().then(
      (status) => setTier(status.tier),
      () => { /* non-critical -- defaults to "free" which blocks access */ },
    );
  }, [fetchBillingStatus]);

  return tier;
}
