/**
 * Google Workspace Marketplace uninstall webhook handler.
 *
 * When a user or admin uninstalls T-Minus from the Google Workspace Marketplace,
 * Google sends a POST webhook with a signed JWT to our uninstall URL. This module:
 *
 * 1. Validates the JWT signature against Google's public keys (RS256)
 * 2. Extracts user or org identity from the JWT claims
 * 3. Revokes OAuth tokens with Google (best-effort, BR-2)
 * 4. Deletes stored credentials from AccountDO (mandatory, BR-1/GDPR)
 * 5. Marks accounts as revoked in D1 registry
 * 6. Records uninstallation in audit log (BR-4)
 *
 * Business rules:
 * - BR-1: Credential deletion is mandatory on uninstall (GDPR)
 * - BR-2: Token revocation with Google is best-effort
 * - BR-3: Uninstall is idempotent (duplicate webhooks handled safely)
 * - BR-4: Audit log records uninstallation for compliance
 *
 * Google Workspace Marketplace uninstall webhook format:
 *   POST /marketplace/uninstall
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: jwt=<signed_jwt>
 *
 * The JWT contains claims like:
 *   iss: "Google Workspace Marketplace"
 *   aud: <our_client_id>
 *   sub: <google_user_subject_id> (for individual uninstall)
 *   email: <user_email>
 *   customer_id: <google_customer_id> (for org-level uninstall)
 *   event_type: "uninstall"
 */

import type { FetchFn } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Google OAuth2 token revocation endpoint. */
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Google's public keys endpoint (JWKS). */
export const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Claims extracted from Google's uninstall JWT. */
export interface UninstallJWTClaims {
  /** Issuer -- typically "Google Workspace Marketplace". */
  readonly iss: string;
  /** Audience -- our OAuth client ID. */
  readonly aud: string;
  /** Subject -- Google user ID (for individual uninstall). */
  readonly sub?: string;
  /** User email address. */
  readonly email?: string;
  /** Google Workspace customer ID (for org-level uninstall). */
  readonly customer_id?: string;
  /** Event type -- should be "uninstall". */
  readonly event_type?: string;
  /** Issued at (Unix seconds). */
  readonly iat: number;
  /** Expiration (Unix seconds). */
  readonly exp: number;
}

/** Result of an individual account uninstall operation. */
export interface UninstallResult {
  /** The account ID that was uninstalled. */
  readonly account_id: string;
  /** Whether OAuth token was successfully revoked with Google (undefined = not attempted). */
  readonly token_revoked?: boolean;
  /** Whether credentials were deleted from AccountDO (undefined = not attempted). */
  readonly credentials_deleted?: boolean;
  /** Whether sync was stopped (undefined = not attempted). */
  readonly sync_stopped?: boolean;
}

/** Result of the complete uninstall webhook processing. */
export interface UninstallWebhookResult {
  /** Whether this was an individual or org-level uninstall. */
  readonly type: "individual" | "organization";
  /** Results for each account processed. */
  readonly accounts: readonly UninstallResult[];
  /** Audit log entry ID. */
  readonly audit_id: string;
  /** Timestamp of the uninstall event. */
  readonly timestamp: string;
  /** Identity info from the JWT. */
  readonly identity: {
    readonly sub?: string;
    readonly email?: string;
    readonly customer_id?: string;
  };
}

/** A single JWK (JSON Web Key) from Google's JWKS endpoint. */
interface GoogleJWK {
  readonly kty: string;
  readonly alg: string;
  readonly use: string;
  readonly kid: string;
  readonly n: string;
  readonly e: string;
}

/** Google JWKS response format. */
interface GoogleJWKS {
  readonly keys: readonly GoogleJWK[];
}

// ---------------------------------------------------------------------------
// Base64URL helpers
// ---------------------------------------------------------------------------

/** Decode a Base64URL string to Uint8Array. */
function b64UrlToBytes(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const fullPadded = pad ? padded + "=".repeat(4 - pad) : padded;
  const decoded = atob(fullPadded);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
}

/** Decode a Base64URL string to a plain string. */
function b64UrlDecode(str: string): string {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const fullPadded = pad ? padded + "=".repeat(4 - pad) : padded;
  return atob(fullPadded);
}

// ---------------------------------------------------------------------------
// JWT validation (RS256 using Web Crypto)
// ---------------------------------------------------------------------------

/**
 * Verify a Google-signed JWT using RS256.
 *
 * Steps:
 * 1. Parse header to get kid (key ID)
 * 2. Fetch Google's public JWKS and find matching key
 * 3. Import the RSA public key using Web Crypto
 * 4. Verify the RS256 signature
 * 5. Validate exp and aud claims
 *
 * @param token - The JWT string to verify
 * @param expectedAudience - The expected aud claim (our OAuth client ID)
 * @param fetchFn - Fetch function (injectable for testing)
 * @returns Decoded claims on success, null on any validation failure
 */
export async function verifyGoogleJWT(
  token: string,
  expectedAudience: string,
  fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
): Promise<UninstallJWTClaims | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;

    // Decode header to get kid and alg
    const header = JSON.parse(b64UrlDecode(headerB64)) as {
      alg: string;
      kid: string;
      typ?: string;
    };

    if (header.alg !== "RS256") return null;
    if (!header.kid) return null;

    // Fetch Google's public keys (JWKS)
    const jwksResponse = await fetchFn(GOOGLE_CERTS_URL);
    if (!jwksResponse.ok) return null;

    const jwks = (await jwksResponse.json()) as GoogleJWKS;
    const matchingKey = jwks.keys.find((k) => k.kid === header.kid);
    if (!matchingKey) return null;

    // Import the RSA public key
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: matchingKey.kty,
        n: matchingKey.n,
        e: matchingKey.e,
        alg: "RS256",
        use: "sig",
      },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );

    // Verify signature
    const signatureBytes = b64UrlToBytes(signatureB64);
    const dataBytes = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      signatureBytes,
      dataBytes,
    );

    if (!valid) return null;

    // Decode payload
    const claims = JSON.parse(b64UrlDecode(payloadB64)) as UninstallJWTClaims;

    // Validate expiration
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp && now >= claims.exp) return null;

    // Validate audience
    if (claims.aud !== expectedAudience) return null;

    return claims;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token revocation (best-effort per BR-2)
// ---------------------------------------------------------------------------

/**
 * Revoke an OAuth token with Google.
 *
 * Best-effort: returns false on failure instead of throwing.
 * Google's revocation endpoint accepts either access or refresh tokens.
 *
 * @param accessToken - The OAuth access token to revoke
 * @param fetchFn - Fetch function (injectable for testing)
 * @returns true if revocation succeeded, false otherwise
 */
export async function revokeGoogleToken(
  accessToken: string,
  fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
): Promise<boolean> {
  try {
    const response = await fetchFn(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: accessToken }).toString(),
    });

    // Google returns 200 on success, but also consider already-revoked tokens
    // as successful (idempotent behavior).
    return response.ok || response.status === 400;
  } catch {
    // Network error -- best-effort means we continue
    return false;
  }
}

// ---------------------------------------------------------------------------
// Account cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up a single account: revoke tokens, delete credentials, stop sync.
 *
 * Follows BR-1 (credential deletion mandatory) and BR-2 (token revocation best-effort).
 * Partial failure in token revocation does NOT block credential cleanup.
 *
 * @param accountId - The T-Minus account ID
 * @param env - Worker environment bindings
 * @param fetchFn - Fetch function (injectable for testing)
 * @returns Result with status of each cleanup step
 */
export async function cleanupAccount(
  accountId: string,
  env: Env,
  fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
): Promise<UninstallResult> {
  const result: {
    account_id: string;
    token_revoked?: boolean;
    credentials_deleted?: boolean;
    sync_stopped?: boolean;
  } = { account_id: accountId };

  const accountDOId = env.ACCOUNT.idFromName(accountId);
  const accountDOStub = env.ACCOUNT.get(accountDOId);

  // Step 1: Attempt to get current tokens for revocation (best-effort)
  try {
    const tokenResponse = await accountDOStub.fetch(
      new Request("https://do/get-token"),
    );
    if (tokenResponse.ok) {
      const tokenData = (await tokenResponse.json()) as {
        access_token?: string;
        refresh_token?: string;
      };
      // Revoke access token if available
      if (tokenData.access_token) {
        result.token_revoked = await revokeGoogleToken(
          tokenData.access_token,
          fetchFn,
        );
      }
      // Also try revoking refresh token (more thorough)
      if (tokenData.refresh_token) {
        await revokeGoogleToken(tokenData.refresh_token, fetchFn);
      }
    } else {
      // AccountDO might not have tokens (already cleaned up) -- that's OK
      result.token_revoked = undefined;
    }
  } catch {
    // Token revocation is best-effort (BR-2)
    result.token_revoked = false;
  }

  // Step 2: Delete credentials from AccountDO (mandatory per BR-1/GDPR)
  try {
    const deleteResponse = await accountDOStub.fetch(
      new Request("https://do/delete-credentials", { method: "POST" }),
    );
    result.credentials_deleted = deleteResponse.ok;
  } catch {
    result.credentials_deleted = false;
  }

  // Step 3: Stop active sync
  try {
    const stopResponse = await accountDOStub.fetch(
      new Request("https://do/stop-sync", { method: "POST" }),
    );
    result.sync_stopped = stopResponse.ok;
  } catch {
    result.sync_stopped = false;
  }

  // Step 4: Mark account as revoked in D1 (regardless of DO success)
  try {
    await env.DB
      .prepare("UPDATE accounts SET status = 'revoked' WHERE account_id = ?")
      .bind(accountId)
      .run();
  } catch {
    // D1 update failure is logged but does not block the response
    console.error(`Failed to update D1 status for account ${accountId}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Audit logging (BR-4)
// ---------------------------------------------------------------------------

/**
 * Record an uninstall event in D1 for compliance audit trail.
 *
 * @param env - Worker environment bindings
 * @param type - "individual" or "organization"
 * @param identity - Identity info from the JWT
 * @param accountResults - Results for each account processed
 * @returns The audit log entry ID
 */
export async function recordUninstallAudit(
  env: Env,
  type: "individual" | "organization",
  identity: { sub?: string; email?: string; customer_id?: string },
  accountResults: readonly UninstallResult[],
): Promise<string> {
  const auditId = `uninstall_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = new Date().toISOString();

  try {
    await env.DB
      .prepare(
        `INSERT INTO uninstall_audit_log (audit_id, event_type, identity_sub, identity_email, identity_customer_id, account_results, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        auditId,
        type,
        identity.sub || null,
        identity.email || null,
        identity.customer_id || null,
        JSON.stringify(accountResults),
        timestamp,
      )
      .run();
  } catch {
    // If audit table doesn't exist yet, log to console as fallback
    // This is a graceful degradation -- the uninstall still completes
    console.error(
      `[AUDIT] Uninstall event: id=${auditId} type=${type} identity=${JSON.stringify(identity)} results=${JSON.stringify(accountResults)} ts=${timestamp}`,
    );
  }

  return auditId;
}

// ---------------------------------------------------------------------------
// Main uninstall webhook handler
// ---------------------------------------------------------------------------

/**
 * Handle the Google Workspace Marketplace uninstall webhook.
 *
 * POST /marketplace/uninstall
 *
 * Google sends a signed JWT in the request body. This handler:
 * 1. Validates the JWT signature and claims
 * 2. Determines if this is individual or org-level uninstall
 * 3. Cleans up all affected accounts
 * 4. Records the event for audit compliance
 * 5. Returns 200 to Google (even on partial failures -- BR-5: idempotent)
 *
 * @param request - The incoming POST request from Google
 * @param env - Worker environment bindings
 * @param fetchFn - Fetch function (injectable for testing)
 * @returns 200 on success, 400/401 on invalid requests
 */
export async function handleMarketplaceUninstall(
  request: Request,
  env: Env,
  fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
): Promise<Response> {
  // Only accept POST
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // Parse the JWT from the request body
  let jwtToken: string;
  const contentType = request.headers.get("Content-Type") || "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const body = await request.text();
    const params = new URLSearchParams(body);
    const token = params.get("jwt");
    if (!token) {
      return jsonResponse({ error: "Missing jwt parameter" }, 400);
    }
    jwtToken = token;
  } else if (contentType.includes("application/json")) {
    const body = (await request.json()) as { jwt?: string };
    if (!body.jwt) {
      return jsonResponse({ error: "Missing jwt field" }, 400);
    }
    jwtToken = body.jwt;
  } else {
    // Try to read the raw body as the JWT itself
    jwtToken = await request.text();
    if (!jwtToken || !jwtToken.includes(".")) {
      return jsonResponse({ error: "Invalid request body" }, 400);
    }
  }

  // Validate the JWT
  const claims = await verifyGoogleJWT(jwtToken, env.GOOGLE_CLIENT_ID, fetchFn);
  if (!claims) {
    return jsonResponse({ error: "Invalid or expired JWT" }, 401);
  }

  // Determine uninstall type and process
  const identity = {
    sub: claims.sub,
    email: claims.email,
    customer_id: claims.customer_id,
  };

  let type: "individual" | "organization";
  let accountResults: UninstallResult[];

  if (claims.customer_id) {
    // Organization-level uninstall
    type = "organization";
    accountResults = await processOrgUninstall(
      claims.customer_id,
      env,
      fetchFn,
    );
  } else if (claims.sub) {
    // Individual uninstall
    type = "individual";
    accountResults = await processIndividualUninstall(
      claims.sub,
      env,
      fetchFn,
    );
  } else {
    return jsonResponse({ error: "JWT missing both sub and customer_id" }, 400);
  }

  // Record audit log (BR-4)
  const auditId = await recordUninstallAudit(env, type, identity, accountResults);

  const result: UninstallWebhookResult = {
    type,
    accounts: accountResults,
    audit_id: auditId,
    timestamp: new Date().toISOString(),
    identity,
  };

  // Always return 200 to Google, even on partial failures (idempotent)
  return jsonResponse(result, 200);
}

// ---------------------------------------------------------------------------
// Individual uninstall
// ---------------------------------------------------------------------------

/**
 * Process an individual user's uninstall: find their accounts and clean them up.
 *
 * @param googleSub - Google user subject ID (provider_subject in accounts table)
 * @param env - Worker environment bindings
 * @param fetchFn - Fetch function
 * @returns Results for each account processed
 */
export async function processIndividualUninstall(
  googleSub: string,
  env: Env,
  fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
): Promise<UninstallResult[]> {
  // Find all Google accounts for this user
  const accountRows = await env.DB
    .prepare(
      "SELECT account_id FROM accounts WHERE provider = 'google' AND provider_subject = ?",
    )
    .bind(googleSub)
    .all<{ account_id: string }>();

  if (accountRows.results.length === 0) {
    // No accounts found -- idempotent (BR-3): already cleaned up or never existed
    return [];
  }

  const results: UninstallResult[] = [];
  for (const row of accountRows.results) {
    const result = await cleanupAccount(row.account_id, env, fetchFn);
    results.push(result);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Organization uninstall
// ---------------------------------------------------------------------------

/**
 * Process an organization-level uninstall: find all org users and clean up each.
 *
 * @param customerId - Google Workspace customer ID
 * @param env - Worker environment bindings
 * @param fetchFn - Fetch function
 * @returns Results for each account processed across all org users
 */
export async function processOrgUninstall(
  customerId: string,
  env: Env,
  fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
): Promise<UninstallResult[]> {
  // Step 1: Find the org installation
  const installation = await env.DB
    .prepare(
      "SELECT install_id, org_id FROM org_installations WHERE google_customer_id = ? AND status = 'active'",
    )
    .bind(customerId)
    .first<{ install_id: string; org_id: string | null }>();

  const results: UninstallResult[] = [];

  if (installation?.org_id) {
    // Step 2: Find all users in this org and their Google accounts
    const orgAccounts = await env.DB
      .prepare(
        `SELECT a.account_id
         FROM accounts a
         JOIN users u ON a.user_id = u.user_id
         WHERE u.org_id = ? AND a.provider = 'google' AND a.status = 'active'`,
      )
      .bind(installation.org_id)
      .all<{ account_id: string }>();

    // Step 3: Clean up each account
    for (const row of orgAccounts.results) {
      const result = await cleanupAccount(row.account_id, env, fetchFn);
      results.push(result);
    }
  }

  // Step 4: Deactivate the org installation record
  if (installation) {
    try {
      await env.DB
        .prepare(
          "UPDATE org_installations SET status = 'inactive', deactivated_at = datetime('now') WHERE install_id = ?",
        )
        .bind(installation.install_id)
        .run();
    } catch {
      console.error(
        `Failed to deactivate org installation ${installation.install_id}`,
      );
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Response helper
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
