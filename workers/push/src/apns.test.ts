/**
 * Unit tests for the APNs module (apns.ts).
 *
 * Covers:
 * - sendToAPNs: success response, error response with reason, network error
 * - sendToAPNs: correct endpoint selection (production vs sandbox)
 * - sendToAPNs: correct HTTP headers (Authorization, apns-topic, etc.)
 * - APNS_UNREGISTERED_REASONS: contains expected reason strings
 * - generateAPNsJWT: returns a valid JWT string format (three dot-separated parts)
 *
 * Global fetch is mocked for sendToAPNs tests.
 * crypto.subtle is available in the test environment for JWT tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendToAPNs, APNS_UNREGISTERED_REASONS } from "./apns";
import type { APNsPayload } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_DEVICE_TOKEN = "abc123def456789012345678901234567890";
const TEST_JWT = "mock.jwt.token";
const TEST_TOPIC = "ink.tminus.app";

const TEST_PAYLOAD: APNsPayload = {
  aps: {
    alert: {
      title: "Test Notification",
      body: "This is a test notification",
    },
    sound: "default",
    category: "drift_alert",
    "thread-id": "tminus-drift_alert",
  },
  notification_type: "drift_alert",
  deep_link: "tminus:///drift/rel-1",
};

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// sendToAPNs tests
// ---------------------------------------------------------------------------

describe("sendToAPNs", () => {
  it("returns success for HTTP 200 response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    const result = await sendToAPNs(
      TEST_DEVICE_TOKEN,
      TEST_PAYLOAD,
      TEST_JWT,
      TEST_TOPIC,
      "production",
    );

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.deviceToken).toBe(TEST_DEVICE_TOKEN);
    expect(result.reason).toBeUndefined();
  });

  it("returns failure with reason for non-200 response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ reason: "BadDeviceToken" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await sendToAPNs(
      TEST_DEVICE_TOKEN,
      TEST_PAYLOAD,
      TEST_JWT,
      TEST_TOPIC,
      "production",
    );

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(result.reason).toBe("BadDeviceToken");
    expect(result.deviceToken).toBe(TEST_DEVICE_TOKEN);
  });

  it("handles non-JSON error response gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const result = await sendToAPNs(
      TEST_DEVICE_TOKEN,
      TEST_PAYLOAD,
      TEST_JWT,
      TEST_TOPIC,
      "production",
    );

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(500);
    // reason may be undefined since body is not JSON
    expect(result.deviceToken).toBe(TEST_DEVICE_TOKEN);
  });

  it("handles network error (fetch throws)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

    const result = await sendToAPNs(
      TEST_DEVICE_TOKEN,
      TEST_PAYLOAD,
      TEST_JWT,
      TEST_TOPIC,
      "production",
    );

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(0);
    expect(result.reason).toBe("Connection refused");
    expect(result.deviceToken).toBe(TEST_DEVICE_TOKEN);
  });

  it("handles non-Error thrown value", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue("network down");

    const result = await sendToAPNs(
      TEST_DEVICE_TOKEN,
      TEST_PAYLOAD,
      TEST_JWT,
      TEST_TOPIC,
      "production",
    );

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(0);
    expect(result.reason).toBe("Unknown error");
    expect(result.deviceToken).toBe(TEST_DEVICE_TOKEN);
  });

  it("uses production endpoint for 'production' environment", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock;

    await sendToAPNs(TEST_DEVICE_TOKEN, TEST_PAYLOAD, TEST_JWT, TEST_TOPIC, "production");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("api.push.apple.com");
    expect(calledUrl).not.toContain("sandbox");
    expect(calledUrl).toContain(`/3/device/${TEST_DEVICE_TOKEN}`);
  });

  it("uses sandbox endpoint for non-production environment", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock;

    await sendToAPNs(TEST_DEVICE_TOKEN, TEST_PAYLOAD, TEST_JWT, TEST_TOPIC, "development");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("api.sandbox.push.apple.com");
    expect(calledUrl).toContain(`/3/device/${TEST_DEVICE_TOKEN}`);
  });

  it("sends correct HTTP headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock;

    await sendToAPNs(TEST_DEVICE_TOKEN, TEST_PAYLOAD, TEST_JWT, TEST_TOPIC, "production");

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;

    expect(headers["Authorization"]).toBe(`bearer ${TEST_JWT}`);
    expect(headers["apns-topic"]).toBe(TEST_TOPIC);
    expect(headers["apns-push-type"]).toBe("alert");
    expect(headers["apns-priority"]).toBe("10");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends payload as JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock;

    await sendToAPNs(TEST_DEVICE_TOKEN, TEST_PAYLOAD, TEST_JWT, TEST_TOPIC, "production");

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(requestInit.body as string);

    expect(body.aps.alert.title).toBe("Test Notification");
    expect(body.notification_type).toBe("drift_alert");
    expect(body.deep_link).toBe("tminus:///drift/rel-1");
  });

  it("uses POST method", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock;

    await sendToAPNs(TEST_DEVICE_TOKEN, TEST_PAYLOAD, TEST_JWT, TEST_TOPIC, "production");

    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(requestInit.method).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// APNS_UNREGISTERED_REASONS tests
// ---------------------------------------------------------------------------

describe("APNS_UNREGISTERED_REASONS", () => {
  it("contains BadDeviceToken", () => {
    expect(APNS_UNREGISTERED_REASONS.has("BadDeviceToken")).toBe(true);
  });

  it("contains Unregistered", () => {
    expect(APNS_UNREGISTERED_REASONS.has("Unregistered")).toBe(true);
  });

  it("contains DeviceTokenNotForTopic", () => {
    expect(APNS_UNREGISTERED_REASONS.has("DeviceTokenNotForTopic")).toBe(true);
  });

  it("contains ExpiredProviderToken", () => {
    expect(APNS_UNREGISTERED_REASONS.has("ExpiredProviderToken")).toBe(true);
  });

  it("does not contain arbitrary values", () => {
    expect(APNS_UNREGISTERED_REASONS.has("InternalServerError")).toBe(false);
    expect(APNS_UNREGISTERED_REASONS.has("ServiceUnavailable")).toBe(false);
  });

  it("has exactly 4 entries", () => {
    expect(APNS_UNREGISTERED_REASONS.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// generateAPNsJWT tests
// ---------------------------------------------------------------------------

describe("generateAPNsJWT", () => {
  // Generate a test ECDSA P-256 key pair for JWT signing
  async function generateTestKey(): Promise<string> {
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );

    const exported = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(exported)));

    // Format as PEM
    const lines: string[] = [];
    for (let i = 0; i < base64.length; i += 64) {
      lines.push(base64.slice(i, i + 64));
    }
    return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
  }

  it("returns a JWT with three dot-separated parts", async () => {
    const { generateAPNsJWT } = await import("./apns");
    const pem = await generateTestKey();

    const jwt = await generateAPNsJWT("KEY123", "TEAM456", pem);

    const parts = jwt.split(".");
    expect(parts.length).toBe(3);
  });

  it("header contains alg=ES256 and kid=keyId", async () => {
    const { generateAPNsJWT } = await import("./apns");
    const pem = await generateTestKey();

    const jwt = await generateAPNsJWT("MY_KEY_ID", "MY_TEAM", pem);

    const headerB64 = jwt.split(".")[0];
    // base64url decode
    const headerJson = atob(headerB64.replace(/-/g, "+").replace(/_/g, "/"));
    const header = JSON.parse(headerJson);

    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe("MY_KEY_ID");
  });

  it("claims contain iss=teamId and iat as number", async () => {
    const { generateAPNsJWT } = await import("./apns");
    const pem = await generateTestKey();

    const beforeTime = Math.floor(Date.now() / 1000);
    const jwt = await generateAPNsJWT("KEY123", "MY_TEAM_ID", pem);
    const afterTime = Math.floor(Date.now() / 1000);

    const claimsB64 = jwt.split(".")[1];
    const claimsJson = atob(claimsB64.replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(claimsJson);

    expect(claims.iss).toBe("MY_TEAM_ID");
    expect(typeof claims.iat).toBe("number");
    expect(claims.iat).toBeGreaterThanOrEqual(beforeTime);
    expect(claims.iat).toBeLessThanOrEqual(afterTime);
  });
});
