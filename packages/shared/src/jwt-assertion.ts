/**
 * Google Service Account JWT Assertion generator.
 *
 * Generates JWT tokens for Google's OAuth2 service account flow
 * (domain-wide delegation). Uses the service account's private key
 * to sign a JWT assertion, which is then exchanged for an access token.
 *
 * Flow:
 *   1. Build JWT header + claims (with subject = impersonated user email)
 *   2. Sign with service account private key (RS256)
 *   3. Exchange signed JWT for access token via Google's token endpoint
 *
 * Reference: https://developers.google.com/identity/protocols/oauth2/service-account
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Google Cloud service account JSON key file shape.
 * Only the fields we actually use for JWT signing.
 */
export interface ServiceAccountKey {
  readonly type: "service_account";
  readonly project_id: string;
  readonly private_key_id: string;
  /** PEM-encoded RSA private key. */
  readonly private_key: string;
  /** Service account email (e.g. "name@project.iam.gserviceaccount.com"). */
  readonly client_email: string;
  /** Numeric client ID used for domain-wide delegation setup. */
  readonly client_id: string;
  readonly auth_uri: string;
  readonly token_uri: string;
}

/**
 * JWT header for Google OAuth2 service account assertion.
 */
interface JwtHeader {
  readonly alg: "RS256";
  readonly typ: "JWT";
  readonly kid: string;
}

/**
 * JWT claims for Google OAuth2 service account assertion.
 */
interface JwtClaims {
  /** Service account email. */
  readonly iss: string;
  /** Token endpoint URL. */
  readonly aud: string;
  /** Issued-at timestamp (seconds since epoch). */
  readonly iat: number;
  /** Expiration timestamp (seconds since epoch). Max 1 hour from iat. */
  readonly exp: number;
  /** Space-separated OAuth2 scopes. */
  readonly scope: string;
  /** Email of the user to impersonate (domain-wide delegation). */
  readonly sub: string;
}

/**
 * Response from Google's OAuth2 token endpoint.
 */
export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Google OAuth2 token endpoint. */
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Default scopes for calendar access via domain-wide delegation. */
export const DELEGATION_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
] as const;

/** JWT maximum lifetime: 1 hour (Google's limit). */
const JWT_LIFETIME_SECONDS = 3600;

// ---------------------------------------------------------------------------
// Base64url encoding (no padding)
// ---------------------------------------------------------------------------

/**
 * Encode a Uint8Array to base64url (RFC 4648 Section 5) without padding.
 */
function base64urlEncode(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Encode a string to base64url.
 */
function base64urlEncodeString(str: string): string {
  return base64urlEncode(new TextEncoder().encode(str));
}

// ---------------------------------------------------------------------------
// PEM parsing
// ---------------------------------------------------------------------------

/**
 * Parse a PEM-encoded RSA private key into a CryptoKey.
 *
 * Strips PEM header/footer and whitespace, decodes base64 to get
 * the DER-encoded PKCS#8 key, then imports via Web Crypto.
 */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Strip PEM header/footer and all whitespace
  const pemBody = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
    .replace(/-----END RSA PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");

  // Decode base64 to binary
  const binaryStr = atob(pemBody);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  return crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// ---------------------------------------------------------------------------
// JWT Assertion Builder
// ---------------------------------------------------------------------------

/**
 * Build a signed JWT assertion for Google service account impersonation.
 *
 * @param serviceAccountKey - The service account JSON key object.
 * @param subject - The email of the user to impersonate.
 * @param scopes - OAuth2 scopes (defaults to DELEGATION_SCOPES).
 * @param nowSeconds - Current time in seconds since epoch (for testing).
 * @returns The signed JWT string (header.payload.signature).
 */
export async function buildJwtAssertion(
  serviceAccountKey: ServiceAccountKey,
  subject: string,
  scopes: readonly string[] = DELEGATION_SCOPES,
  nowSeconds?: number,
): Promise<string> {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);

  const header: JwtHeader = {
    alg: "RS256",
    typ: "JWT",
    kid: serviceAccountKey.private_key_id,
  };

  const claims: JwtClaims = {
    iss: serviceAccountKey.client_email,
    aud: serviceAccountKey.token_uri || GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + JWT_LIFETIME_SECONDS,
    scope: scopes.join(" "),
    sub: subject,
  };

  // Build unsigned token: base64url(header).base64url(claims)
  const headerB64 = base64urlEncodeString(JSON.stringify(header));
  const claimsB64 = base64urlEncodeString(JSON.stringify(claims));
  const unsignedToken = `${headerB64}.${claimsB64}`;

  // Sign with RSA-SHA256
  const privateKey = await importPrivateKey(serviceAccountKey.private_key);
  const signatureBytes = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      privateKey,
      new TextEncoder().encode(unsignedToken),
    ),
  );
  const signatureB64 = base64urlEncode(signatureBytes);

  return `${unsignedToken}.${signatureB64}`;
}

// ---------------------------------------------------------------------------
// Token Exchange
// ---------------------------------------------------------------------------

/**
 * Injectable fetch function for testing.
 */
type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Exchange a signed JWT assertion for a Google access token.
 *
 * Makes a POST to Google's token endpoint with grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer.
 *
 * @param signedJwt - The signed JWT assertion from buildJwtAssertion().
 * @param fetchFn - Injectable fetch function (for testing).
 * @returns TokenResponse with access_token, token_type, and expires_in.
 * @throws Error if Google rejects the assertion.
 */
export async function exchangeJwtForToken(
  signedJwt: string,
  fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: signedJwt,
  });

  const response = await fetchFn(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `JWT token exchange failed (${response.status}): ${errorText}`,
    );
  }

  return (await response.json()) as TokenResponse;
}

/**
 * High-level: get an access token for impersonating a user.
 *
 * Combines JWT assertion building and token exchange in one call.
 *
 * @param serviceAccountKey - The service account JSON key.
 * @param subject - Email of the user to impersonate.
 * @param scopes - OAuth2 scopes (defaults to DELEGATION_SCOPES).
 * @param fetchFn - Injectable fetch (for testing).
 * @returns Access token string.
 */
export async function getImpersonationToken(
  serviceAccountKey: ServiceAccountKey,
  subject: string,
  scopes: readonly string[] = DELEGATION_SCOPES,
  fetchFn?: FetchFn,
): Promise<string> {
  const jwt = await buildJwtAssertion(serviceAccountKey, subject, scopes);
  const tokenResponse = await exchangeJwtForToken(jwt, fetchFn);
  return tokenResponse.access_token;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a JSON object has the shape of a Google service account key.
 * Returns null if valid, or an error string describing the first problem found.
 */
export function validateServiceAccountKey(key: unknown): string | null {
  if (!key || typeof key !== "object") {
    return "Service account key must be a JSON object";
  }

  const k = key as Record<string, unknown>;

  if (k.type !== "service_account") {
    return "Service account key must have type 'service_account'";
  }

  const requiredFields = [
    "project_id",
    "private_key_id",
    "private_key",
    "client_email",
    "client_id",
    "token_uri",
  ] as const;

  for (const field of requiredFields) {
    if (!k[field] || typeof k[field] !== "string") {
      return `Service account key missing required field: ${field}`;
    }
  }

  if (!(k.private_key as string).includes("PRIVATE KEY")) {
    return "Service account private_key does not appear to be a PEM-encoded key";
  }

  return null;
}
