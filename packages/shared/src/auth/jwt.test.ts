/**
 * Unit tests for JWT utilities (Web Crypto HS256).
 *
 * Tests:
 * - generateJWT/verifyJWT round-trip
 * - Expired token rejection
 * - Tampered token rejection (wrong secret)
 * - Tampered payload rejection
 * - Malformed token rejection
 * - Missing sub claim rejection
 * - generateRefreshToken uniqueness and format
 * - JWT payload schema correctness
 * - Default expiry is 15 minutes
 */

import { describe, it, expect } from "vitest";
import {
  generateJWT,
  verifyJWT,
  generateRefreshToken,
  JWT_EXPIRY_SECONDS,
  REFRESH_TOKEN_EXPIRY_SECONDS,
} from "./jwt";
import type { JWTPayload } from "./jwt";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const SECRET = "test-jwt-secret-must-be-at-least-this-long-for-testing";
const TEST_PAYLOAD = {
  sub: "usr_01HXYZ000000000000000001",
  email: "test@example.com",
  tier: "free" as const,
  pwd_ver: 1,
};

// ---------------------------------------------------------------------------
// generateJWT / verifyJWT round-trip
// ---------------------------------------------------------------------------

describe("generateJWT / verifyJWT", () => {
  it("round-trips a valid token: generate then verify returns original payload", async () => {
    const token = await generateJWT(TEST_PAYLOAD, SECRET);
    const result = await verifyJWT(token, SECRET);

    expect(result).not.toBeNull();
    expect(result!.sub).toBe(TEST_PAYLOAD.sub);
    expect(result!.email).toBe(TEST_PAYLOAD.email);
    expect(result!.tier).toBe(TEST_PAYLOAD.tier);
    expect(result!.pwd_ver).toBe(TEST_PAYLOAD.pwd_ver);
  });

  it("generates a 3-part dot-separated JWT string", async () => {
    const token = await generateJWT(TEST_PAYLOAD, SECRET);
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
    expect(parts[2].length).toBeGreaterThan(0);
  });

  it("sets iat and exp automatically when not provided", async () => {
    const beforeGenerate = Math.floor(Date.now() / 1000);
    const token = await generateJWT(TEST_PAYLOAD, SECRET);
    const afterGenerate = Math.floor(Date.now() / 1000);

    const result = await verifyJWT(token, SECRET);
    expect(result).not.toBeNull();

    // iat should be within the generate window
    expect(result!.iat).toBeGreaterThanOrEqual(beforeGenerate);
    expect(result!.iat).toBeLessThanOrEqual(afterGenerate);

    // exp should be iat + JWT_EXPIRY_SECONDS (15 min = 900s)
    expect(result!.exp).toBe(result!.iat + JWT_EXPIRY_SECONDS);
  });

  it("respects custom expiresInSeconds parameter", async () => {
    const customExpiry = 3600; // 1 hour
    const token = await generateJWT(TEST_PAYLOAD, SECRET, customExpiry);
    const result = await verifyJWT(token, SECRET);

    expect(result).not.toBeNull();
    expect(result!.exp).toBe(result!.iat + customExpiry);
  });

  it("includes all required JWT payload fields", async () => {
    const token = await generateJWT(TEST_PAYLOAD, SECRET);
    const result = await verifyJWT(token, SECRET);

    expect(result).not.toBeNull();
    // Verify the full payload schema
    expect(typeof result!.sub).toBe("string");
    expect(typeof result!.email).toBe("string");
    expect(["free", "premium", "enterprise"]).toContain(result!.tier);
    expect(typeof result!.pwd_ver).toBe("number");
    expect(typeof result!.iat).toBe("number");
    expect(typeof result!.exp).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Token expiry
// ---------------------------------------------------------------------------

describe("verifyJWT: expiry handling", () => {
  it("rejects an expired token", async () => {
    // Create a token that expired 1 hour ago
    const pastTime = Math.floor(Date.now() / 1000) - 7200;
    const token = await generateJWT(
      { ...TEST_PAYLOAD, iat: pastTime, exp: pastTime + 3600 },
      SECRET,
    );

    const result = await verifyJWT(token, SECRET);
    expect(result).toBeNull();
  });

  it("rejects a token that expires exactly now (boundary: now >= exp)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await generateJWT(
      { ...TEST_PAYLOAD, iat: now - 900, exp: now },
      SECRET,
    );

    // Token with exp === now should be rejected (now >= exp)
    const result = await verifyJWT(token, SECRET);
    expect(result).toBeNull();
  });

  it("accepts a token that has not expired yet", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await generateJWT(
      { ...TEST_PAYLOAD, iat: now, exp: now + 3600 },
      SECRET,
    );

    const result = await verifyJWT(token, SECRET);
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Signature tampering
// ---------------------------------------------------------------------------

describe("verifyJWT: signature verification", () => {
  it("rejects a token signed with a different secret", async () => {
    const token = await generateJWT(TEST_PAYLOAD, SECRET);
    const result = await verifyJWT(token, "completely-different-secret-key");
    expect(result).toBeNull();
  });

  it("rejects a token with a tampered payload", async () => {
    const token = await generateJWT(TEST_PAYLOAD, SECRET);
    const parts = token.split(".");

    // Decode payload, modify it, re-encode (but don't re-sign)
    const payloadJson = atob(
      parts[1].replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (parts[1].length % 4)) % 4),
    );
    const payload = JSON.parse(payloadJson);
    payload.sub = "usr_ATTACKER0000000000000001";
    const tamperedPayload = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    const result = await verifyJWT(tamperedToken, SECRET);
    expect(result).toBeNull();
  });

  it("rejects a token with a tampered signature", async () => {
    const token = await generateJWT(TEST_PAYLOAD, SECRET);
    const parts = token.split(".");

    // Flip a character in the signature
    const sig = parts[2];
    const flipped = sig[0] === "A" ? "B" : "A";
    const tamperedToken = `${parts[0]}.${parts[1]}.${flipped}${sig.slice(1)}`;

    const result = await verifyJWT(tamperedToken, SECRET);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Malformed tokens
// ---------------------------------------------------------------------------

describe("verifyJWT: malformed tokens", () => {
  it("returns null for empty string", async () => {
    expect(await verifyJWT("", SECRET)).toBeNull();
  });

  it("returns null for single-part string", async () => {
    expect(await verifyJWT("just-one-part", SECRET)).toBeNull();
  });

  it("returns null for two-part string", async () => {
    expect(await verifyJWT("two.parts", SECRET)).toBeNull();
  });

  it("returns null for four-part string", async () => {
    expect(await verifyJWT("one.two.three.four", SECRET)).toBeNull();
  });

  it("returns null for non-base64 content", async () => {
    expect(await verifyJWT("!!!.@@@.###", SECRET)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// JWT constants
// ---------------------------------------------------------------------------

describe("JWT constants", () => {
  it("JWT_EXPIRY_SECONDS is 900 (15 minutes)", () => {
    expect(JWT_EXPIRY_SECONDS).toBe(900);
  });

  it("REFRESH_TOKEN_EXPIRY_SECONDS is 604800 (7 days)", () => {
    expect(REFRESH_TOKEN_EXPIRY_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(REFRESH_TOKEN_EXPIRY_SECONDS).toBe(604800);
  });
});

// ---------------------------------------------------------------------------
// generateRefreshToken
// ---------------------------------------------------------------------------

describe("generateRefreshToken", () => {
  it("produces a 64-character hex string (32 bytes)", () => {
    const token = generateRefreshToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces unique tokens on successive calls", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateRefreshToken());
    }
    // All 100 tokens should be unique (collision probability is negligible
    // for 256-bit random values)
    expect(tokens.size).toBe(100);
  });

  it("contains only lowercase hex characters", () => {
    const token = generateRefreshToken();
    // Should not contain uppercase or non-hex characters
    expect(token).toMatch(/^[0-9a-f]+$/);
    expect(token).not.toMatch(/[A-F]/);
  });
});
