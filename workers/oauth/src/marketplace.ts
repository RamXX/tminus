/**
 * Google Workspace Marketplace install callback handler.
 *
 * When a user installs T-Minus from the Google Workspace Marketplace,
 * Google redirects them to our install URL with their identity and
 * granted OAuth tokens. This module:
 *
 * 1. Parses the Marketplace install callback parameters
 * 2. Creates or finds the user record in D1
 * 3. Pre-connects their Google account (reusing existing AccountDO flow)
 * 4. Redirects to Phase 6A onboarding with Google account already connected
 *
 * Google Workspace Marketplace install flow:
 *   User clicks "Install" in Marketplace
 *   -> Google shows consent screen (scopes already granted via Marketplace)
 *   -> Google redirects to our install URL with auth code
 *   -> We exchange code for tokens (same as normal OAuth)
 *   -> We create user + account records
 *   -> We redirect to onboarding with account pre-connected
 *
 * The key difference from normal OAuth: the user did NOT start from our app.
 * They came from the Marketplace, so we need to create the user record first.
 */

import { generateId } from "@tminus/shared";
import type { FetchFn } from "@tminus/shared";
import type { AccountRow } from "@tminus/d1-registry";
import {
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  GOOGLE_SCOPES,
} from "./google";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed parameters from a Marketplace install callback. */
export interface MarketplaceInstallParams {
  /** OAuth authorization code from Google. */
  readonly code: string;
  /** OAuth scopes granted during Marketplace install. */
  readonly scope?: string;
  /** HD (hosted domain) of the user's Workspace. */
  readonly hd?: string;
}

/** Result of a successful Marketplace install flow. */
export interface MarketplaceInstallResult {
  /** The user ID (newly created or existing). */
  readonly user_id: string;
  /** The account ID for the pre-connected Google account. */
  readonly account_id: string;
  /** Whether this is a new user (true) or existing user (false). */
  readonly is_new_user: boolean;
  /** The user's email address. */
  readonly email: string;
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
 * Parse Marketplace install callback parameters from a URL.
 *
 * Google redirects to our install URL with:
 *   ?code=<auth_code>&scope=<granted_scopes>&hd=<hosted_domain>
 *
 * The code is mandatory; scope and hd are optional.
 *
 * @param url - The full callback URL
 * @returns Parsed parameters, or null if the code parameter is missing
 */
export function parseMarketplaceCallback(url: URL): MarketplaceInstallParams | null {
  const code = url.searchParams.get("code");
  if (!code) {
    return null;
  }

  return {
    code,
    scope: url.searchParams.get("scope") ?? undefined,
    hd: url.searchParams.get("hd") ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Install handler
// ---------------------------------------------------------------------------

/**
 * Handle a Marketplace install callback.
 *
 * This is the core logic that:
 * 1. Exchanges the auth code for tokens
 * 2. Fetches user identity from Google
 * 3. Creates or finds the user in D1
 * 4. Creates or reactivates the Google account in D1
 * 5. Initializes AccountDO with tokens
 * 6. Starts the OnboardingWorkflow for new accounts
 *
 * @returns A redirect Response to the onboarding page, or an error Response
 */
export async function handleMarketplaceInstall(
  request: Request,
  env: Env,
  fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
): Promise<Response> {
  const url = new URL(request.url);

  // Check for error response from Google
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    return htmlError(
      "Installation Failed",
      "The Marketplace installation was cancelled or denied.",
      200,
    );
  }

  // Parse the callback parameters
  const params = parseMarketplaceCallback(url);
  if (!params) {
    return htmlError(
      "Installation Failed",
      "Missing required parameters from Google Workspace Marketplace.",
      400,
    );
  }

  const callbackUrl = `${url.origin}/marketplace/install`;

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
      console.error(`Marketplace token exchange failed (${tokenResponse.status}): ${body}`);
      return htmlError(
        "Something Went Wrong",
        "Something went wrong during installation. Please try again.",
        502,
      );
    }

    tokenData = await tokenResponse.json() as GoogleTokenResponse;
  } catch (err) {
    console.error("Marketplace token exchange error:", err);
    return htmlError(
      "Something Went Wrong",
      "Something went wrong during installation. Please try again.",
      502,
    );
  }

  if (!tokenData.refresh_token) {
    console.error("No refresh_token in Marketplace token response.");
    return htmlError(
      "Something Went Wrong",
      "Something went wrong during installation. Please try again.",
      502,
    );
  }

  // Step 2: Fetch Google userinfo for identity
  let userInfo: GoogleUserInfo;
  try {
    const userInfoResponse = await fetchFn(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userInfoResponse.ok) {
      const body = await userInfoResponse.text();
      console.error(`Marketplace userinfo fetch failed (${userInfoResponse.status}): ${body}`);
      return htmlError(
        "Something Went Wrong",
        "Something went wrong during installation. Please try again.",
        502,
      );
    }

    userInfo = await userInfoResponse.json() as GoogleUserInfo;
  } catch (err) {
    console.error("Marketplace userinfo fetch error:", err);
    return htmlError(
      "Something Went Wrong",
      "Something went wrong during installation. Please try again.",
      502,
    );
  }

  // Step 3: Find or create user in D1
  // First check if a user with this email already exists
  const existingUserRows = await env.DB
    .prepare("SELECT user_id FROM users WHERE email = ?")
    .bind(userInfo.email)
    .all<{ user_id: string }>();

  let userId: string;
  let isNewUser = false;

  if (existingUserRows.results.length > 0) {
    userId = existingUserRows.results[0].user_id;
  } else {
    // Create a new user -- requires an org. For Marketplace installs,
    // use a default org (or create one based on the hosted domain).
    userId = generateId("user");
    isNewUser = true;

    // Ensure a default org exists for Marketplace-originated users.
    // For Workspace users, the hd (hosted domain) identifies the org.
    const orgId = generateId("org");
    const orgName = userInfo.hd || "Personal";

    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO orgs (org_id, name) VALUES (?, ?)`,
      )
      .bind(orgId, orgName)
      .run();

    await env.DB
      .prepare(
        `INSERT INTO users (user_id, org_id, email, display_name) VALUES (?, ?, ?, ?)`,
      )
      .bind(userId, orgId, userInfo.email, userInfo.name || null)
      .run();
  }

  // Step 4: Check if this Google account is already linked
  const existingAccountRows = await env.DB
    .prepare("SELECT account_id, user_id, status FROM accounts WHERE provider = ? AND provider_subject = ?")
    .bind("google", userInfo.sub)
    .all<Pick<AccountRow, "account_id" | "user_id" | "status">>();

  const existingAccount = existingAccountRows.results.length > 0
    ? existingAccountRows.results[0]
    : null;

  let accountId: string;
  let isNewAccount = false;

  if (existingAccount) {
    // Account exists -- reactivate if needed
    accountId = existingAccount.account_id;

    if (existingAccount.status !== "active") {
      await env.DB
        .prepare("UPDATE accounts SET status = 'active', email = ? WHERE account_id = ?")
        .bind(userInfo.email, accountId)
        .run();
    }
  } else {
    // Create new account
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

  // Step 5: Initialize AccountDO with encrypted tokens
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

  // Step 6: Start OnboardingWorkflow for new accounts
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
      // Log but don't fail -- onboarding can be retried
      console.error("Failed to start OnboardingWorkflow from Marketplace install:", err);
    }
  }

  // Step 7: Redirect to onboarding with pre-connected account
  // The onboarding UI detects the marketplace_install=true parameter
  // and shows the Google account as already connected.
  const onboardingUrl = new URL(`${url.origin}/onboarding`);
  onboardingUrl.searchParams.set("user_id", userId);
  onboardingUrl.searchParams.set("account_id", accountId);
  onboardingUrl.searchParams.set("marketplace_install", "true");
  onboardingUrl.searchParams.set("provider", "google");
  onboardingUrl.searchParams.set("email", userInfo.email);
  if (!isNewUser) {
    onboardingUrl.searchParams.set("existing_user", "true");
  }

  return Response.redirect(onboardingUrl.toString(), 302);
}

// ---------------------------------------------------------------------------
// Error response helper (shared with index.ts pattern)
// ---------------------------------------------------------------------------

function htmlError(title: string, message: string, status: number): Response {
  const body = `<!DOCTYPE html><html><head><title>${title}</title></head>` +
    `<body><h1>${title}</h1><p>${message}</p></body></html>`;
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
