/**
 * PKCE (Proof Key for Code Exchange) utilities for OAuth2.
 *
 * Generates code_verifier and code_challenge per RFC 7636.
 * Uses Web Crypto API for cross-platform compatibility
 * (Cloudflare Workers, Node.js, browsers).
 */

// Base64url encoding (RFC 4648 Section 5): no padding, URL-safe chars.
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generate a PKCE code_verifier: 32 random bytes => 43 base64url chars.
 *
 * RFC 7636 requires 43-128 unreserved characters. 32 bytes of randomness
 * produces 43 base64url characters, meeting the minimum length requirement
 * while providing 256 bits of entropy.
 */
export function generateCodeVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64url(bytes);
}

/**
 * Generate a PKCE code_challenge from a code_verifier using S256 method.
 *
 * code_challenge = BASE64URL(SHA256(code_verifier))
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return base64url(new Uint8Array(digest));
}
