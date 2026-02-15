/**
 * @tminus/shared -- JWT utilities using Web Crypto API (HS256).
 *
 * No external JWT libraries -- all signing/verification uses
 * crypto.subtle.sign / crypto.subtle.verify (HMAC SHA-256).
 *
 * JWT payload schema:
 *   sub:     string   (usr_ ULID)
 *   email:   string
 *   tier:    'free' | 'premium' | 'enterprise'
 *   pwd_ver: number   (password version for session invalidation)
 *   iat:     number   (issued at, Unix seconds)
 *   exp:     number   (expiration, Unix seconds)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default JWT expiry: 15 minutes (in seconds). */
export const JWT_EXPIRY_SECONDS = 900;

/** Default refresh token expiry: 7 days (in seconds). */
export const REFRESH_TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subscription tier for JWT payload. */
export type SubscriptionTier = "free" | "premium" | "enterprise";

/** JWT payload structure for T-Minus auth tokens. */
export interface JWTPayload {
  /** Subject -- user ID (usr_ ULID). */
  sub: string;
  /** User email address. */
  email: string;
  /** Subscription tier. */
  tier: SubscriptionTier;
  /** Password version for session invalidation. */
  pwd_ver: number;
  /** Issued at (Unix seconds). */
  iat: number;
  /** Expiration (Unix seconds). */
  exp: number;
}

// ---------------------------------------------------------------------------
// Base64URL encoding / decoding
// ---------------------------------------------------------------------------

/** Encode a string to Base64URL (no padding). */
function b64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Encode a Uint8Array to Base64URL (no padding). */
function bytesToB64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode a Base64URL string to a plain string. */
function b64UrlDecode(str: string): string {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const fullPadded = pad ? padded + "=".repeat(4 - pad) : padded;
  return atob(fullPadded);
}

/** Decode a Base64URL string to Uint8Array. */
function b64UrlToBytes(str: string): Uint8Array {
  const decoded = b64UrlDecode(str);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// HMAC key import helper
// ---------------------------------------------------------------------------

async function importHmacKey(
  secret: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a JWT signed with HS256 using the Web Crypto API.
 *
 * @param payload - Token claims (sub, email, tier, pwd_ver required).
 *                  iat and exp will be auto-set if not provided.
 * @param secret  - HMAC signing secret.
 * @param expiresInSeconds - Expiry offset in seconds from now. Defaults to 15 minutes.
 * @returns A signed JWT string (header.payload.signature).
 */
export async function generateJWT(
  payload: Omit<JWTPayload, "iat" | "exp"> & { iat?: number; exp?: number },
  secret: string,
  expiresInSeconds: number = JWT_EXPIRY_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JWTPayload = {
    ...payload,
    iat: payload.iat ?? now,
    exp: payload.exp ?? now + expiresInSeconds,
  };

  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = b64UrlEncode(JSON.stringify(header));
  const payloadB64 = b64UrlEncode(JSON.stringify(fullPayload));

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const key = await importHmacKey(secret, "sign");
  const signature = await crypto.subtle.sign("HMAC", key, signingInput);
  const signatureB64 = bytesToB64Url(new Uint8Array(signature));

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

/**
 * Verify and decode a JWT token.
 *
 * Checks:
 * 1. Three-part structure
 * 2. Header alg === "HS256"
 * 3. HMAC signature validity
 * 4. Expiration (exp claim)
 * 5. Subject claim presence (sub)
 *
 * @param token  - The JWT string to verify.
 * @param secret - The HMAC secret used to sign the token.
 * @returns The decoded payload on success, or null on any failure.
 */
export async function verifyJWT(
  token: string,
  secret: string,
): Promise<JWTPayload | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;

    // Decode and verify header
    const header = JSON.parse(b64UrlDecode(headerB64));
    if (header.alg !== "HS256") return null;

    // Verify HMAC signature
    const key = await importHmacKey(secret, "verify");
    const signatureData = b64UrlToBytes(signatureB64);
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const valid = await crypto.subtle.verify("HMAC", key, signatureData, signingInput);
    if (!valid) return null;

    // Decode payload
    const payload = JSON.parse(b64UrlDecode(payloadB64)) as JWTPayload;

    // Check expiration
    if (payload.exp !== undefined && typeof payload.exp === "number") {
      const now = Math.floor(Date.now() / 1000);
      if (now >= payload.exp) return null;
    }

    // Must have sub claim
    if (!payload.sub || typeof payload.sub !== "string") return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Generate a cryptographically secure refresh token.
 *
 * Uses crypto.getRandomValues to generate 32 random bytes,
 * then hex-encodes them (64 character string).
 *
 * @returns A 64-character hex-encoded random string.
 */
export function generateRefreshToken(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const hexParts: string[] = [];
  for (const byte of randomBytes) {
    hexParts.push(byte.toString(16).padStart(2, "0"));
  }
  return hexParts.join("");
}
