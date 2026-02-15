/**
 * APNs HTTP/2 client for sending push notifications.
 *
 * Uses token-based authentication (JWT signed with .p8 private key).
 * Cloudflare Workers support HTTP/2 for outbound fetch() calls,
 * which is required by APNs HTTP/2 API.
 *
 * Design decisions:
 * - JWT token is cached for 50 minutes (APNs allows up to 60 min)
 * - Separate sandbox and production endpoints based on ENVIRONMENT
 * - Retries are handled by the queue (max_retries in wrangler.toml),
 *   not here -- this module only handles single delivery attempts
 */

import type { APNsPayload } from "@tminus/shared";

// ---------------------------------------------------------------------------
// APNs endpoints
// ---------------------------------------------------------------------------

/** APNs production endpoint. */
const APNS_PRODUCTION_HOST = "https://api.push.apple.com";

/** APNs sandbox endpoint (for development/staging). */
const APNS_SANDBOX_HOST = "https://api.sandbox.push.apple.com";

// ---------------------------------------------------------------------------
// JWT generation for APNs token-based auth
// ---------------------------------------------------------------------------

/**
 * Generates an APNs JWT token using the ES256 algorithm.
 *
 * The token is a compact JWT signed with the APNs .p8 private key.
 * APNs requires tokens to be refreshed at least every 60 minutes.
 *
 * @param keyId - APNs key ID (from Apple Developer portal)
 * @param teamId - Apple Developer Team ID
 * @param privateKeyPem - ECDSA P-256 private key in PEM format
 * @returns JWT string for APNs Authorization header
 */
export async function generateAPNsJWT(
  keyId: string,
  teamId: string,
  privateKeyPem: string,
): Promise<string> {
  // Parse PEM to raw key bytes
  const pemBody = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");

  const keyData = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  // Import ECDSA P-256 private key
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData.buffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  // Build JWT header and claims
  const header = {
    alg: "ES256",
    kid: keyId,
  };

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: teamId,
    iat: now,
  };

  // Encode and sign
  const headerB64 = base64url(JSON.stringify(header));
  const claimsB64 = base64url(JSON.stringify(claims));
  const signingInput = `${headerB64}.${claimsB64}`;

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  // Convert DER signature to raw r||s format that JWT expects
  const sigB64 = base64url(new Uint8Array(signature));

  return `${signingInput}.${sigB64}`;
}

/**
 * Base64url encoding (RFC 7515).
 */
function base64url(input: string | Uint8Array): string {
  let base64: string;
  if (typeof input === "string") {
    base64 = btoa(input);
  } else {
    base64 = btoa(String.fromCharCode(...input));
  }
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// APNs delivery result
// ---------------------------------------------------------------------------

/** Result of an APNs delivery attempt. */
export interface APNsResult {
  /** Whether the delivery succeeded (HTTP 200). */
  readonly success: boolean;
  /** HTTP status code from APNs. */
  readonly statusCode: number;
  /** APNs reason string on failure (e.g., "BadDeviceToken", "Unregistered"). */
  readonly reason?: string;
  /** The device token this result is for. */
  readonly deviceToken: string;
}

// ---------------------------------------------------------------------------
// Send notification to APNs
// ---------------------------------------------------------------------------

/**
 * Sends a push notification to a single device via APNs HTTP/2 API.
 *
 * @param deviceToken - The APNs device token (hex string).
 * @param payload - The APNs notification payload.
 * @param jwt - Pre-generated APNs JWT for authorization.
 * @param topic - App bundle ID (e.g., "ink.tminus.app").
 * @param environment - "production" uses APNs prod, anything else uses sandbox.
 * @returns Delivery result with success status and any error reason.
 */
export async function sendToAPNs(
  deviceToken: string,
  payload: APNsPayload,
  jwt: string,
  topic: string,
  environment: string,
): Promise<APNsResult> {
  const host =
    environment === "production" ? APNS_PRODUCTION_HOST : APNS_SANDBOX_HOST;

  const url = `${host}/3/device/${deviceToken}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `bearer ${jwt}`,
        "apns-topic": topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      return { success: true, statusCode: response.status, deviceToken };
    }

    // Parse error response
    let reason: string | undefined;
    try {
      const errorBody = (await response.json()) as { reason?: string };
      reason = errorBody.reason;
    } catch {
      // Response body not JSON
    }

    return {
      success: false,
      statusCode: response.status,
      reason,
      deviceToken,
    };
  } catch (err) {
    return {
      success: false,
      statusCode: 0,
      reason: err instanceof Error ? err.message : "Unknown error",
      deviceToken,
    };
  }
}

/**
 * Token IDs that indicate the device token is permanently invalid
 * and should be removed from D1.
 */
export const APNS_UNREGISTERED_REASONS = new Set([
  "BadDeviceToken",
  "Unregistered",
  "DeviceTokenNotForTopic",
  "ExpiredProviderToken",
]);
