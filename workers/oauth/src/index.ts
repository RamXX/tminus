/**
 * tminus-oauth -- OAuth callback and token exchange worker.
 *
 * Endpoints:
 *   GET /oauth/google/start        -- Initiate Google PKCE flow
 *   GET /oauth/google/callback     -- Handle Google redirect, exchange tokens
 *   GET /oauth/microsoft/start     -- Initiate Microsoft OAuth flow
 *   GET /oauth/microsoft/callback  -- Handle Microsoft redirect, exchange tokens
 *   GET /health                    -- Health check
 *
 * This worker is stateless: user context is encrypted into the state
 * parameter using AES-256-GCM, eliminating the need for KV or cookie storage.
 */

import { generateId, buildHealthResponse } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Workflow class re-export (required by wrangler for Workflow hosting)
// ---------------------------------------------------------------------------

export { OnboardingWorkflow } from "@tminus/workflow-onboarding";
import type { FetchFn } from "@tminus/shared";
export type { FetchFn } from "@tminus/shared";
import type { AccountRow } from "@tminus/d1-registry";
import { generateCodeVerifier, generateCodeChallenge } from "./pkce";
import { encryptState, decryptState } from "./state";
import {
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  GOOGLE_SCOPES,
  CALLBACK_PATH,
} from "./google";
import {
  MS_AUTH_URL,
  MS_TOKEN_URL,
  MS_USERINFO_URL,
  MS_SCOPES,
  MS_CALLBACK_PATH,
} from "./microsoft";
import { handleMarketplaceInstall } from "./marketplace";
import { handleAdminInstall, handleOrgUserActivation } from "./marketplace-admin";
import { handleMarketplaceUninstall } from "./marketplace-uninstall";
import { handlePrivacyPolicy, handleTermsOfService } from "./legal";
import { handleSupportPage } from "./support";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
}

/** Response from Microsoft token exchange. */
interface MicrosoftTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

/** Response from Microsoft Graph /me endpoint. */
interface MicrosoftUserInfo {
  id: string;
  mail: string | null;
  displayName?: string;
  userPrincipalName: string;
}

// ---------------------------------------------------------------------------
// Error response helpers
// ---------------------------------------------------------------------------

function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function htmlError(title: string, message: string, status: number): Response {
  const body = `<!DOCTYPE html><html><head><title>${title}</title></head>` +
    `<body><h1>${title}</h1><p>${message}</p></body></html>`;
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// Route: GET /oauth/google/start
// ---------------------------------------------------------------------------

async function handleStart(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get("user_id");

  if (!userId) {
    return errorResponse("Missing required parameter: user_id", 400);
  }

  const redirectUri = url.searchParams.get("redirect_uri") || `${url.origin}/oauth/google/done`;

  // Generate PKCE pair
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // Encrypt context into state parameter
  const state = await encryptState(env.JWT_SECRET, codeVerifier, userId, redirectUri);

  // Build the callback URL for this worker
  const callbackUrl = `${url.origin}${CALLBACK_PATH}`;

  // Build Google consent URL
  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_SCOPES);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return Response.redirect(authUrl.toString(), 302);
}

// ---------------------------------------------------------------------------
// Route: GET /oauth/google/callback
// ---------------------------------------------------------------------------

async function handleCallback(
  request: Request,
  env: Env,
  fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
): Promise<Response> {
  const url = new URL(request.url);

  // Check if user denied consent
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    return htmlError("Access Denied", "You declined access. No account was linked.", 200);
  }

  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");

  if (!code || !stateParam) {
    return htmlError("Link Failed", "Missing required parameters from Google.", 400);
  }

  // Decrypt and validate state
  const statePayload = await decryptState(env.JWT_SECRET, stateParam);
  if (!statePayload) {
    return htmlError("Link Failed", "Link failed. Please try again.", 400);
  }

  const { code_verifier, user_id, redirect_uri } = statePayload;
  const callbackUrl = `${url.origin}${CALLBACK_PATH}`;

  // Step 1: Exchange authorization code for tokens
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
        code_verifier,
      }).toString(),
    });

    if (!tokenResponse.ok) {
      const body = await tokenResponse.text();
      console.error(`Token exchange failed (${tokenResponse.status}): ${body}`);
      return htmlError("Something Went Wrong", "Something went wrong. Please try again.", 502);
    }

    tokenData = await tokenResponse.json() as GoogleTokenResponse;
  } catch (err) {
    console.error("Token exchange error:", err);
    return htmlError("Something Went Wrong", "Something went wrong. Please try again.", 502);
  }

  if (!tokenData.refresh_token) {
    console.error("No refresh_token in token response. Was prompt=consent used?");
    return htmlError("Something Went Wrong", "Something went wrong. Please try again.", 502);
  }

  // Step 2: Fetch Google userinfo for provider_subject and email
  let userInfo: GoogleUserInfo;
  try {
    const userInfoResponse = await fetchFn(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userInfoResponse.ok) {
      const body = await userInfoResponse.text();
      console.error(`Userinfo fetch failed (${userInfoResponse.status}): ${body}`);
      return htmlError("Something Went Wrong", "Something went wrong. Please try again.", 502);
    }

    userInfo = await userInfoResponse.json() as GoogleUserInfo;
  } catch (err) {
    console.error("Userinfo fetch error:", err);
    return htmlError("Something Went Wrong", "Something went wrong. Please try again.", 502);
  }

  // Step 3: Check D1 for existing account with this (provider, provider_subject)
  const existingRows = await env.DB
    .prepare("SELECT account_id, user_id, status FROM accounts WHERE provider = ? AND provider_subject = ?")
    .bind("google", userInfo.sub)
    .all<Pick<AccountRow, "account_id" | "user_id" | "status">>();

  const existing = existingRows.results.length > 0 ? existingRows.results[0] : null;

  let accountId: string;
  let isNewAccount = false;

  if (existing) {
    if (existing.user_id !== user_id) {
      // Different user already linked this Google account
      return htmlError(
        "Account Already Linked",
        "This Google account is already linked to another user.",
        409,
      );
    }

    // Same user -- re-activate and refresh tokens
    accountId = existing.account_id;

    // Update status to active if it was revoked/error
    if (existing.status !== "active") {
      await env.DB
        .prepare("UPDATE accounts SET status = 'active', email = ? WHERE account_id = ?")
        .bind(userInfo.email, accountId)
        .run();
    }
  } else {
    // New account
    accountId = generateId("account");
    isNewAccount = true;

    await env.DB
      .prepare(
        `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
         VALUES (?, ?, 'google', ?, ?, 'active')`,
      )
      .bind(accountId, user_id, userInfo.sub, userInfo.email)
      .run();
  }

  // Step 4: Initialize AccountDO with encrypted tokens
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

  // Step 5: Start OnboardingWorkflow for new accounts
  if (isNewAccount) {
    try {
      await env.ONBOARDING_WORKFLOW.create({
        id: `onboard-${accountId}`,
        params: {
          account_id: accountId,
          user_id: user_id,
        },
      });
    } catch (err) {
      // Log but don't fail the OAuth flow -- onboarding can be retried
      console.error("Failed to start OnboardingWorkflow:", err);
    }
  }

  // Step 6: Redirect to success URL
  const successUrl = new URL(redirect_uri);
  successUrl.searchParams.set("account_id", accountId);
  if (!isNewAccount) {
    successUrl.searchParams.set("reactivated", "true");
  }

  return Response.redirect(successUrl.toString(), 302);
}

// ---------------------------------------------------------------------------
// Route: GET /oauth/microsoft/start
// ---------------------------------------------------------------------------

async function handleMicrosoftStart(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get("user_id");

  if (!userId) {
    return errorResponse("Missing required parameter: user_id", 400);
  }

  const redirectUri = url.searchParams.get("redirect_uri") || `${url.origin}/oauth/microsoft/done`;

  // Encrypt context into state parameter (code_verifier slot unused for Microsoft)
  const state = await encryptState(env.JWT_SECRET, "not-used-for-ms", userId, redirectUri);

  // Build the callback URL for this worker
  const callbackUrl = `${url.origin}${MS_CALLBACK_PATH}`;

  // Build Microsoft authorization URL
  const authUrl = new URL(MS_AUTH_URL);
  authUrl.searchParams.set("client_id", env.MS_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", MS_SCOPES);
  authUrl.searchParams.set("response_mode", "query");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  return Response.redirect(authUrl.toString(), 302);
}

// ---------------------------------------------------------------------------
// Route: GET /oauth/microsoft/callback
// ---------------------------------------------------------------------------

async function handleMicrosoftCallback(
  request: Request,
  env: Env,
  fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
): Promise<Response> {
  const url = new URL(request.url);

  // Check if user denied consent
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    return htmlError("Access Denied", "You declined access. No account was linked.", 200);
  }

  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");

  if (!code || !stateParam) {
    return htmlError("Link Failed", "Missing required parameters from Microsoft.", 400);
  }

  // Decrypt and validate state
  const statePayload = await decryptState(env.JWT_SECRET, stateParam);
  if (!statePayload) {
    return htmlError("Link Failed", "Link failed. Please try again.", 400);
  }

  const { user_id, redirect_uri } = statePayload;
  const callbackUrl = `${url.origin}${MS_CALLBACK_PATH}`;

  // Step 1: Exchange authorization code for tokens
  let tokenData: MicrosoftTokenResponse;
  try {
    const tokenResponse = await fetchFn(MS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.MS_CLIENT_ID,
        client_secret: env.MS_CLIENT_SECRET,
        redirect_uri: callbackUrl,
        grant_type: "authorization_code",
        scope: MS_SCOPES,
      }).toString(),
    });

    if (!tokenResponse.ok) {
      // Handle non-JSON responses gracefully (Microsoft can return HTML on 5xx)
      const body = await tokenResponse.text();
      console.error(`Microsoft token exchange failed (${tokenResponse.status}): ${body}`);
      return htmlError("Something Went Wrong", "Something went wrong. Please try again.", 502);
    }

    // Parse token response, guarding against non-JSON bodies
    const responseText = await tokenResponse.text();
    try {
      tokenData = JSON.parse(responseText) as MicrosoftTokenResponse;
    } catch {
      console.error("Microsoft token endpoint returned non-JSON response:", responseText.slice(0, 200));
      return htmlError("Something Went Wrong", "Something went wrong. Please try again.", 502);
    }
  } catch (err) {
    console.error("Microsoft token exchange error:", err);
    return htmlError("Something Went Wrong", "Something went wrong. Please try again.", 502);
  }

  if (!tokenData.refresh_token) {
    console.error("No refresh_token in Microsoft token response. Was offline_access scope requested?");
    return htmlError("Something Went Wrong", "Something went wrong. Please try again.", 502);
  }

  // Step 2: Fetch Microsoft Graph /me for provider_subject and email
  let userInfo: MicrosoftUserInfo;
  try {
    const userInfoResponse = await fetchFn(MS_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userInfoResponse.ok) {
      const body = await userInfoResponse.text();
      console.error(`Microsoft userinfo fetch failed (${userInfoResponse.status}): ${body}`);
      return htmlError("Something Went Wrong", "Something went wrong. Please try again.", 502);
    }

    userInfo = await userInfoResponse.json() as MicrosoftUserInfo;
  } catch (err) {
    console.error("Microsoft userinfo fetch error:", err);
    return htmlError("Something Went Wrong", "Something went wrong. Please try again.", 502);
  }

  // Microsoft Graph /me: `mail` can be null for some accounts, fall back to userPrincipalName
  const email = userInfo.mail || userInfo.userPrincipalName;
  const providerSubject = userInfo.id;

  // Step 3: Check D1 for existing account with this (provider, provider_subject)
  const existingRows = await env.DB
    .prepare("SELECT account_id, user_id, status FROM accounts WHERE provider = ? AND provider_subject = ?")
    .bind("microsoft", providerSubject)
    .all<Pick<AccountRow, "account_id" | "user_id" | "status">>();

  const existing = existingRows.results.length > 0 ? existingRows.results[0] : null;

  let accountId: string;
  let isNewAccount = false;

  if (existing) {
    if (existing.user_id !== user_id) {
      // Different user already linked this Microsoft account
      return htmlError(
        "Account Already Linked",
        "This Microsoft account is already linked to another user.",
        409,
      );
    }

    // Same user -- re-activate and refresh tokens
    accountId = existing.account_id;

    // Update status to active if it was revoked/error
    if (existing.status !== "active") {
      await env.DB
        .prepare("UPDATE accounts SET status = 'active', email = ? WHERE account_id = ?")
        .bind(email, accountId)
        .run();
    }
  } else {
    // New account
    accountId = generateId("account");
    isNewAccount = true;

    await env.DB
      .prepare(
        `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
         VALUES (?, ?, 'microsoft', ?, ?, 'active')`,
      )
      .bind(accountId, user_id, providerSubject, email)
      .run();
  }

  // Step 4: Initialize AccountDO with encrypted tokens
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
      scopes: tokenData.scope || MS_SCOPES,
    }),
  }));

  // Step 5: Start OnboardingWorkflow for new accounts
  if (isNewAccount) {
    try {
      await env.ONBOARDING_WORKFLOW.create({
        id: `onboard-${accountId}`,
        params: {
          account_id: accountId,
          user_id: user_id,
        },
      });
    } catch (err) {
      // Log but don't fail the OAuth flow -- onboarding can be retried
      console.error("Failed to start OnboardingWorkflow:", err);
    }
  }

  // Step 6: Redirect to success URL
  const successUrl = new URL(redirect_uri);
  successUrl.searchParams.set("account_id", accountId);
  if (!isNewAccount) {
    successUrl.searchParams.set("reactivated", "true");
  }

  return Response.redirect(successUrl.toString(), 302);
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

/**
 * Create the worker handler with an optional fetch function override.
 * This factory pattern allows tests to inject a mock fetch.
 */
export function createHandler(fetchFn?: FetchFn) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);

      // Health check -- no auth, no method restriction
      if (url.pathname === "/health") {
        const healthBody = buildHealthResponse(
          "tminus-oauth",
          "0.0.1",
          env.ENVIRONMENT ?? "development",
          [
            { name: "DB", type: "d1", available: !!env.DB },
            { name: "USER_GRAPH", type: "do", available: !!env.USER_GRAPH },
            { name: "ACCOUNT", type: "do", available: !!env.ACCOUNT },
            { name: "ONBOARDING_WORKFLOW", type: "workflow", available: !!env.ONBOARDING_WORKFLOW },
          ],
        );
        return new Response(JSON.stringify(healthBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // POST /marketplace/uninstall -- webhook from Google (must be before GET-only check)
      if (url.pathname === "/marketplace/uninstall") {
        return handleMarketplaceUninstall(request, env, fetchFn);
      }

      if (request.method !== "GET") {
        return errorResponse("Method not allowed", 405);
      }

      switch (url.pathname) {
        case "/oauth/google/start":
          return handleStart(request, env);
        case "/oauth/google/callback":
          return handleCallback(request, env, fetchFn);
        case "/oauth/microsoft/start":
          return handleMicrosoftStart(request, env);
        case "/oauth/microsoft/callback":
          return handleMicrosoftCallback(request, env, fetchFn);
        case "/marketplace/install":
          return handleMarketplaceInstall(request, env, fetchFn);
        case "/marketplace/admin-install":
          return handleAdminInstall(request, env, fetchFn);
        case "/marketplace/org-activate":
          return handleOrgUserActivation(request, env, fetchFn);
        case "/legal/privacy":
          return handlePrivacyPolicy();
        case "/legal/terms":
          return handleTermsOfService();
        case "/support":
          return handleSupportPage();
        default:
          return errorResponse("Not found", 404);
      }
    },
  };
}

export default createHandler();
