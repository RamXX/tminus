/**
 * Google Workspace Marketplace admin install callback handler.
 *
 * When an admin installs T-Minus from the Google Workspace admin console
 * for their entire organization, Google redirects to a different install
 * URL with organization-level parameters. This module:
 *
 * 1. Parses the admin install callback (includes Google customer ID)
 * 2. Exchanges the auth code for admin-level tokens
 * 3. Creates an org_installations record in D1
 * 4. Optionally links to an existing organization record
 * 5. Redirects to admin confirmation page
 *
 * Key difference from individual install (marketplace.ts):
 * - Admin grants consent on behalf of the ENTIRE organization
 * - No per-user OAuth consent is required for users in the org
 * - Google customer ID identifies the Workspace org
 *
 * Business rules (TM-ga8.4):
 * - BR-1: Org install does NOT auto-sync user calendars (opt-in by visiting)
 * - BR-2: Admin deactivation disconnects all org users and removes credentials
 * - BR-3: Individual users can still disconnect their own account
 */

import { generateId } from "@tminus/shared";
import type { FetchFn } from "@tminus/shared";
import {
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  GOOGLE_SCOPES,
} from "./google";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed parameters from an admin install callback. */
export interface AdminInstallParams {
  /** OAuth authorization code from Google. */
  readonly code: string;
  /** Google Workspace customer ID (organization identifier). */
  readonly customer_id: string;
  /** OAuth scopes granted during admin install. */
  readonly scope?: string;
  /** HD (hosted domain) of the admin's Workspace. */
  readonly hd?: string;
}

/** Result of a successful admin install flow. */
export interface AdminInstallResult {
  /** The org installation ID (newly created). */
  readonly install_id: string;
  /** The Google Workspace customer ID. */
  readonly customer_id: string;
  /** The admin's email address. */
  readonly admin_email: string;
  /** Whether an existing org was linked. */
  readonly org_linked: boolean;
}

/** Response from Google token exchange. */
interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

/** Response from Google userinfo endpoint. */
interface GoogleUserInfo {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
  hd?: string;
}

// ---------------------------------------------------------------------------
// Callback parsing
// ---------------------------------------------------------------------------

/**
 * Parse admin install callback parameters from a URL.
 *
 * Admin installs include a customer_id parameter that identifies the
 * Google Workspace organization, in addition to the standard auth code.
 *
 * @param url - The full callback URL
 * @returns Parsed parameters, or null if required params are missing
 */
export function parseAdminInstallCallback(url: URL): AdminInstallParams | null {
  const code = url.searchParams.get("code");
  const customerId = url.searchParams.get("customer_id");

  if (!code || !customerId) {
    return null;
  }

  return {
    code,
    customer_id: customerId,
    scope: url.searchParams.get("scope") ?? undefined,
    hd: url.searchParams.get("hd") ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Install handler
// ---------------------------------------------------------------------------

/**
 * Handle an admin install callback from Google Workspace Marketplace.
 *
 * This is the core logic for org-level installation:
 * 1. Exchanges the auth code for tokens (admin-level)
 * 2. Fetches admin identity from Google
 * 3. Creates or updates the org_installations record in D1
 * 4. Links to existing organization if one matches the hosted domain
 * 5. Redirects to admin confirmation page
 *
 * @returns A redirect Response to the admin confirmation page, or an error Response
 */
export async function handleAdminInstall(
  request: Request,
  env: Env,
  fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
): Promise<Response> {
  const url = new URL(request.url);

  // Check for error response from Google
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    return htmlError(
      "Organization Installation Failed",
      "The organization installation was cancelled or denied by the admin.",
      200,
    );
  }

  // Parse the admin install callback parameters
  const params = parseAdminInstallCallback(url);
  if (!params) {
    return htmlError(
      "Organization Installation Failed",
      "Missing required parameters from Google Workspace Marketplace. Both code and customer_id are required for admin install.",
      400,
    );
  }

  const callbackUrl = `${url.origin}/marketplace/admin-install`;

  // Step 1: Exchange authorization code for tokens
  let tokenData: GoogleTokenResponse;
  try {
    const tokenResponse = await fetchFn(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: params.code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: callbackUrl,
        grant_type: "authorization_code",
      }).toString(),
    });

    if (!tokenResponse.ok) {
      const body = await tokenResponse.text();
      console.error(`Admin install token exchange failed (${tokenResponse.status}): ${body}`);
      return htmlError(
        "Something Went Wrong",
        "Something went wrong during organization installation. Please try again.",
        502,
      );
    }

    tokenData = await tokenResponse.json() as GoogleTokenResponse;
  } catch (err) {
    console.error("Admin install token exchange error:", err);
    return htmlError(
      "Something Went Wrong",
      "Something went wrong during organization installation. Please try again.",
      502,
    );
  }

  // Step 2: Fetch Google userinfo for admin identity
  let userInfo: GoogleUserInfo;
  try {
    const userInfoResponse = await fetchFn(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userInfoResponse.ok) {
      const body = await userInfoResponse.text();
      console.error(`Admin install userinfo fetch failed (${userInfoResponse.status}): ${body}`);
      return htmlError(
        "Something Went Wrong",
        "Something went wrong during organization installation. Please try again.",
        502,
      );
    }

    userInfo = await userInfoResponse.json() as GoogleUserInfo;
  } catch (err) {
    console.error("Admin install userinfo fetch error:", err);
    return htmlError(
      "Something Went Wrong",
      "Something went wrong during organization installation. Please try again.",
      502,
    );
  }

  // Step 3: Check if this org already has an installation
  const existingInstall = await env.DB
    .prepare("SELECT install_id, status FROM org_installations WHERE google_customer_id = ?")
    .bind(params.customer_id)
    .first<{ install_id: string; status: string }>();

  let installId: string;

  if (existingInstall) {
    // Reactivate existing installation
    installId = existingInstall.install_id;
    await env.DB
      .prepare(
        "UPDATE org_installations SET status = 'active', admin_email = ?, admin_google_sub = ?, scopes_granted = ?, deactivated_at = NULL WHERE install_id = ?",
      )
      .bind(
        userInfo.email,
        userInfo.sub,
        tokenData.scope || GOOGLE_SCOPES,
        installId,
      )
      .run();
  } else {
    // Create new installation record
    installId = generateId("orgInstall");

    // Try to find an existing org by the hosted domain
    let orgId: string | null = null;
    if (userInfo.hd) {
      const existingOrg = await env.DB
        .prepare("SELECT org_id FROM organizations WHERE name = ?")
        .bind(userInfo.hd)
        .first<{ org_id: string }>();

      if (existingOrg) {
        orgId = existingOrg.org_id;
      }
    }

    await env.DB
      .prepare(
        `INSERT INTO org_installations (install_id, google_customer_id, org_id, admin_email, admin_google_sub, scopes_granted)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        installId,
        params.customer_id,
        orgId,
        userInfo.email,
        userInfo.sub,
        tokenData.scope || GOOGLE_SCOPES,
      )
      .run();
  }

  // Step 4: Redirect to admin confirmation page
  const confirmUrl = new URL(`${url.origin}/onboarding`);
  confirmUrl.searchParams.set("install_id", installId);
  confirmUrl.searchParams.set("customer_id", params.customer_id);
  confirmUrl.searchParams.set("admin_email", userInfo.email);
  confirmUrl.searchParams.set("admin_install", "true");
  confirmUrl.searchParams.set("org_domain", userInfo.hd || "");

  return Response.redirect(confirmUrl.toString(), 302);
}

// ---------------------------------------------------------------------------
// Org user activation handler
// ---------------------------------------------------------------------------

/**
 * Handle org user activation when a user in an org-installed Workspace visits T-Minus.
 *
 * When an org user visits, we:
 * 1. Check their email domain against active org installations
 * 2. If found, skip OAuth consent and create user+account records
 * 3. Use the org-level granted tokens (admin consented on their behalf)
 * 4. Redirect to onboarding with account pre-connected
 *
 * Note: The user must still exchange a code -- Google sends them through
 * a lightweight consent flow but the org-level consent covers the scopes.
 *
 * @returns A redirect Response, or an error Response
 */
export async function handleOrgUserActivation(
  request: Request,
  env: Env,
  fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
): Promise<Response> {
  const url = new URL(request.url);

  // Check for error response from Google
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    return htmlError(
      "Activation Failed",
      "The activation was cancelled or denied.",
      200,
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return htmlError(
      "Activation Failed",
      "Missing authorization code. Please try again.",
      400,
    );
  }

  const callbackUrl = `${url.origin}/marketplace/org-activate`;

  // Step 1: Exchange code for tokens
  let tokenData: GoogleTokenResponse;
  try {
    const tokenResponse = await fetchFn(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: callbackUrl,
        grant_type: "authorization_code",
      }).toString(),
    });

    if (!tokenResponse.ok) {
      const body = await tokenResponse.text();
      console.error(`Org user activation token exchange failed (${tokenResponse.status}): ${body}`);
      return htmlError(
        "Something Went Wrong",
        "Something went wrong during activation. Please try again.",
        502,
      );
    }

    tokenData = await tokenResponse.json() as GoogleTokenResponse;
  } catch (err) {
    console.error("Org user activation token exchange error:", err);
    return htmlError(
      "Something Went Wrong",
      "Something went wrong during activation. Please try again.",
      502,
    );
  }

  if (!tokenData.refresh_token) {
    console.error("No refresh_token in org user activation response.");
    return htmlError(
      "Something Went Wrong",
      "Something went wrong during activation. Please try again.",
      502,
    );
  }

  // Step 2: Fetch userinfo
  let userInfo: GoogleUserInfo;
  try {
    const userInfoResponse = await fetchFn(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userInfoResponse.ok) {
      const body = await userInfoResponse.text();
      console.error(`Org user activation userinfo failed (${userInfoResponse.status}): ${body}`);
      return htmlError(
        "Something Went Wrong",
        "Something went wrong during activation. Please try again.",
        502,
      );
    }

    userInfo = await userInfoResponse.json() as GoogleUserInfo;
  } catch (err) {
    console.error("Org user activation userinfo error:", err);
    return htmlError(
      "Something Went Wrong",
      "Something went wrong during activation. Please try again.",
      502,
    );
  }

  // Step 3: Detect org membership via hosted domain
  const orgInstall = await detectOrgMembership(userInfo.hd, env.DB);
  if (!orgInstall) {
    return htmlError(
      "Organization Not Found",
      "Your organization does not have T-Minus installed. Please ask your administrator to install it from the Google Workspace Marketplace.",
      403,
    );
  }

  // Step 4: Find or create user record
  const existingUserRows = await env.DB
    .prepare("SELECT user_id FROM users WHERE email = ?")
    .bind(userInfo.email)
    .all<{ user_id: string }>();

  let userId: string;
  let isNewUser = false;

  if (existingUserRows.results.length > 0) {
    userId = existingUserRows.results[0].user_id;
  } else {
    userId = generateId("user");
    isNewUser = true;

    // Use org from installation if available, otherwise create one
    let orgId = orgInstall.org_id;
    if (!orgId) {
      orgId = generateId("org");
      const orgName = userInfo.hd || "Organization";
      await env.DB
        .prepare("INSERT OR IGNORE INTO orgs (org_id, name) VALUES (?, ?)")
        .bind(orgId, orgName)
        .run();
    }

    await env.DB
      .prepare("INSERT INTO users (user_id, org_id, email, display_name) VALUES (?, ?, ?, ?)")
      .bind(userId, orgId, userInfo.email, userInfo.name || null)
      .run();
  }

  // Step 5: Create or reactivate account
  const existingAccountRows = await env.DB
    .prepare("SELECT account_id, user_id, status FROM accounts WHERE provider = ? AND provider_subject = ?")
    .bind("google", userInfo.sub)
    .all<{ account_id: string; user_id: string; status: string }>();

  let accountId: string;
  let isNewAccount = false;
  const existingAccount = existingAccountRows.results.length > 0
    ? existingAccountRows.results[0]
    : null;

  if (existingAccount) {
    accountId = existingAccount.account_id;
    if (existingAccount.status !== "active") {
      await env.DB
        .prepare("UPDATE accounts SET status = 'active', email = ? WHERE account_id = ?")
        .bind(userInfo.email, accountId)
        .run();
    }
  } else {
    accountId = generateId("account");
    isNewAccount = true;

    await env.DB
      .prepare(
        `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
         VALUES (?, ?, 'google', ?, ?, 'active')`,
      )
      .bind(accountId, userId, userInfo.sub, userInfo.email)
      .run();
  }

  // Step 6: Initialize AccountDO with tokens
  const expiry = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
  const accountDOId = env.ACCOUNT.idFromName(accountId);
  const accountDOStub = env.ACCOUNT.get(accountDOId);

  await accountDOStub.fetch(new Request("https://do/initialize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tokens: {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expiry,
      },
      scopes: tokenData.scope || GOOGLE_SCOPES,
    }),
  }));

  // Step 7: Start onboarding workflow for new accounts
  if (isNewAccount) {
    try {
      await env.ONBOARDING_WORKFLOW.create({
        id: `onboard-${accountId}`,
        params: {
          account_id: accountId,
          user_id: userId,
        },
      });
    } catch (err) {
      console.error("Failed to start OnboardingWorkflow from org activation:", err);
    }
  }

  // Step 8: Redirect to onboarding with pre-connected account
  const onboardingUrl = new URL(`${url.origin}/onboarding`);
  onboardingUrl.searchParams.set("user_id", userId);
  onboardingUrl.searchParams.set("account_id", accountId);
  onboardingUrl.searchParams.set("marketplace_install", "true");
  onboardingUrl.searchParams.set("org_install", "true");
  onboardingUrl.searchParams.set("provider", "google");
  onboardingUrl.searchParams.set("email", userInfo.email);
  if (!isNewUser) {
    onboardingUrl.searchParams.set("existing_user", "true");
  }

  return Response.redirect(onboardingUrl.toString(), 302);
}

// ---------------------------------------------------------------------------
// Org membership detection (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Detect whether a user's hosted domain maps to an active org installation.
 *
 * Uses the hosted domain (hd) from Google userinfo to find an active
 * org_installations record whose admin email domain matches.
 *
 * @param hd - The user's hosted domain (e.g., "acme.com")
 * @param db - D1 database binding
 * @returns The matching org installation, or null if no match
 */
export async function detectOrgMembership(
  hd: string | undefined,
  db: D1Database,
): Promise<{ install_id: string; org_id: string | null; google_customer_id: string } | null> {
  if (!hd) {
    return null;
  }

  // Find active org installations where the admin's domain matches
  // The admin_email domain must match the user's hosted domain
  const result = await db
    .prepare(
      "SELECT install_id, org_id, google_customer_id FROM org_installations WHERE status = 'active' AND admin_email LIKE ?",
    )
    .bind(`%@${hd}`)
    .first<{ install_id: string; org_id: string | null; google_customer_id: string }>();

  return result ?? null;
}

// ---------------------------------------------------------------------------
// Error response helper
// ---------------------------------------------------------------------------

function htmlError(title: string, message: string, status: number): Response {
  const body = `<!DOCTYPE html><html><head><title>${title}</title></head>` +
    `<body><h1>${title}</h1><p>${message}</p></body></html>`;
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
