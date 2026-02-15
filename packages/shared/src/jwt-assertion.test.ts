/**
 * Unit tests for Google service account JWT assertion generation.
 *
 * Tests:
 * - JWT assertion header correctness (alg, typ, kid)
 * - JWT assertion claims correctness (iss, aud, sub, scope, iat, exp)
 * - Base64url encoding (no padding, URL-safe characters)
 * - Service account key validation (required fields, PEM format)
 * - PEM private key import
 * - Token exchange request format
 */

import { describe, it, expect } from "vitest";
import {
  buildJwtAssertion,
  exchangeJwtForToken,
  validateServiceAccountKey,
  importPrivateKey,
  DELEGATION_SCOPES,
} from "./jwt-assertion";
import type { ServiceAccountKey } from "./jwt-assertion";

// ---------------------------------------------------------------------------
// Test RSA key pair (2048-bit, generated for testing only)
// ---------------------------------------------------------------------------

// This is a test-only PKCS#8 PEM key. NEVER use in production.
// Generated via: node -e "const {generateKeyPairSync} = require('crypto'); ..."
const TEST_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nSCRUBBED_TEST_KEY_REPLACED_WITH_RUNTIME_GENERATION\n-----END PRIVATE KEY-----\n";

const TEST_SERVICE_ACCOUNT_KEY: ServiceAccountKey = {
  type: "service_account",
  project_id: "test-project-123",
  private_key_id: "key-id-abc123",
  private_key: TEST_PRIVATE_KEY,
  client_email: "test-sa@test-project-123.iam.gserviceaccount.com",
  client_id: "123456789012345678901",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
};

// ---------------------------------------------------------------------------
// Helper: decode base64url without padding
// ---------------------------------------------------------------------------

function base64urlDecode(str: string): string {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return atob(base64);
}

// ---------------------------------------------------------------------------
// validateServiceAccountKey
// ---------------------------------------------------------------------------

describe("validateServiceAccountKey", () => {
  it("accepts a valid service account key", () => {
    expect(validateServiceAccountKey(TEST_SERVICE_ACCOUNT_KEY)).toBeNull();
  });

  it("rejects null input", () => {
    expect(validateServiceAccountKey(null)).toBe("Service account key must be a JSON object");
  });

  it("rejects non-object input", () => {
    expect(validateServiceAccountKey("string")).toBe("Service account key must be a JSON object");
  });

  it("rejects wrong type field", () => {
    expect(validateServiceAccountKey({ ...TEST_SERVICE_ACCOUNT_KEY, type: "user" })).toBe(
      "Service account key must have type 'service_account'",
    );
  });

  it("rejects missing project_id", () => {
    const { project_id, ...rest } = TEST_SERVICE_ACCOUNT_KEY;
    expect(validateServiceAccountKey(rest)).toBe(
      "Service account key missing required field: project_id",
    );
  });

  it("rejects missing private_key", () => {
    const key = { ...TEST_SERVICE_ACCOUNT_KEY, private_key: "" };
    expect(validateServiceAccountKey(key)).toBe(
      "Service account key missing required field: private_key",
    );
  });

  it("rejects non-PEM private_key", () => {
    const key = { ...TEST_SERVICE_ACCOUNT_KEY, private_key: "not-a-pem-key" };
    expect(validateServiceAccountKey(key)).toBe(
      "Service account private_key does not appear to be a PEM-encoded key",
    );
  });

  it("rejects missing client_email", () => {
    const key = { ...TEST_SERVICE_ACCOUNT_KEY, client_email: "" };
    expect(validateServiceAccountKey(key)).toBe(
      "Service account key missing required field: client_email",
    );
  });

  it("rejects missing client_id", () => {
    const key = { ...TEST_SERVICE_ACCOUNT_KEY, client_id: "" };
    expect(validateServiceAccountKey(key)).toBe(
      "Service account key missing required field: client_id",
    );
  });

  it("rejects missing token_uri", () => {
    const key = { ...TEST_SERVICE_ACCOUNT_KEY, token_uri: "" };
    expect(validateServiceAccountKey(key)).toBe(
      "Service account key missing required field: token_uri",
    );
  });
});

// ---------------------------------------------------------------------------
// DELEGATION_SCOPES
// ---------------------------------------------------------------------------

describe("DELEGATION_SCOPES", () => {
  it("contains calendar.readonly scope", () => {
    expect(DELEGATION_SCOPES).toContain("https://www.googleapis.com/auth/calendar.readonly");
  });

  it("contains calendar.events scope", () => {
    expect(DELEGATION_SCOPES).toContain("https://www.googleapis.com/auth/calendar.events");
  });

  it("contains calendar.calendarlist.readonly scope", () => {
    expect(DELEGATION_SCOPES).toContain(
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    );
  });

  it("has exactly 3 scopes", () => {
    expect(DELEGATION_SCOPES).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// importPrivateKey
// ---------------------------------------------------------------------------

describe("importPrivateKey", () => {
  it("imports a valid PEM private key", async () => {
    const key = await importPrivateKey(TEST_PRIVATE_KEY);
    expect(key).toBeDefined();
    expect(key.type).toBe("private");
    expect(key.algorithm).toMatchObject({ name: "RSASSA-PKCS1-v1_5" });
  });

  it("rejects invalid PEM data", async () => {
    await expect(importPrivateKey("not-valid-pem")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildJwtAssertion
// ---------------------------------------------------------------------------

describe("buildJwtAssertion", () => {
  it("produces a three-part JWT (header.claims.signature)", async () => {
    const jwt = await buildJwtAssertion(
      TEST_SERVICE_ACCOUNT_KEY,
      "user@example.com",
      DELEGATION_SCOPES,
      1700000000,
    );

    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    // All parts should be non-empty
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
    expect(parts[2].length).toBeGreaterThan(0);
  });

  it("sets correct JWT header fields", async () => {
    const jwt = await buildJwtAssertion(
      TEST_SERVICE_ACCOUNT_KEY,
      "user@example.com",
      DELEGATION_SCOPES,
      1700000000,
    );

    const header = JSON.parse(base64urlDecode(jwt.split(".")[0]));
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");
    expect(header.kid).toBe("key-id-abc123");
  });

  it("sets correct JWT claims", async () => {
    const jwt = await buildJwtAssertion(
      TEST_SERVICE_ACCOUNT_KEY,
      "user@example.com",
      DELEGATION_SCOPES,
      1700000000,
    );

    const claims = JSON.parse(base64urlDecode(jwt.split(".")[1]));
    expect(claims.iss).toBe("test-sa@test-project-123.iam.gserviceaccount.com");
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(claims.sub).toBe("user@example.com");
    expect(claims.iat).toBe(1700000000);
    expect(claims.exp).toBe(1700003600); // iat + 3600
    expect(claims.scope).toBe(
      "https://www.googleapis.com/auth/calendar.readonly " +
      "https://www.googleapis.com/auth/calendar.events " +
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    );
  });

  it("uses custom scopes when provided", async () => {
    const jwt = await buildJwtAssertion(
      TEST_SERVICE_ACCOUNT_KEY,
      "user@example.com",
      ["https://www.googleapis.com/auth/calendar.readonly"],
      1700000000,
    );

    const claims = JSON.parse(base64urlDecode(jwt.split(".")[1]));
    expect(claims.scope).toBe("https://www.googleapis.com/auth/calendar.readonly");
  });

  it("produces URL-safe base64 (no +, /, or = characters)", async () => {
    const jwt = await buildJwtAssertion(
      TEST_SERVICE_ACCOUNT_KEY,
      "user@example.com",
      DELEGATION_SCOPES,
      1700000000,
    );

    // None of the three parts should contain +, /, or =
    expect(jwt).not.toMatch(/[+/=]/);
  });

  it("uses current time when nowSeconds not provided", async () => {
    const before = Math.floor(Date.now() / 1000);
    const jwt = await buildJwtAssertion(
      TEST_SERVICE_ACCOUNT_KEY,
      "user@example.com",
    );
    const after = Math.floor(Date.now() / 1000);

    const claims = JSON.parse(base64urlDecode(jwt.split(".")[1]));
    expect(claims.iat).toBeGreaterThanOrEqual(before);
    expect(claims.iat).toBeLessThanOrEqual(after);
    expect(claims.exp).toBe(claims.iat + 3600);
  });
});

// ---------------------------------------------------------------------------
// exchangeJwtForToken
// ---------------------------------------------------------------------------

describe("exchangeJwtForToken", () => {
  it("sends correct request to Google token endpoint", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = typeof input === "string" ? input : (input as Request).url;
      capturedInit = init;
      return new Response(
        JSON.stringify({
          access_token: "ya29.mock-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await exchangeJwtForToken("signed-jwt-string", mockFetch);

    expect(capturedUrl).toBe("https://oauth2.googleapis.com/token");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
    });

    // Body should contain grant_type and assertion
    const body = capturedInit?.body as string;
    expect(body).toContain("grant_type=urn");
    expect(body).toContain("assertion=signed-jwt-string");

    expect(result.access_token).toBe("ya29.mock-token");
    expect(result.token_type).toBe("Bearer");
    expect(result.expires_in).toBe(3600);
  });

  it("throws on non-200 response", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response("Invalid grant", { status: 400 });
    };

    await expect(exchangeJwtForToken("bad-jwt", mockFetch)).rejects.toThrow(
      "JWT token exchange failed (400): Invalid grant",
    );
  });

  it("throws on 401 response with error details", async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response('{"error":"invalid_client"}', { status: 401 });
    };

    await expect(exchangeJwtForToken("bad-jwt", mockFetch)).rejects.toThrow(
      "JWT token exchange failed (401)",
    );
  });
});
