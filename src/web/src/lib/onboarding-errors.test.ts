/**
 * Unit tests for onboarding error classification, retry logic, and telemetry.
 *
 * Covers:
 * - OAuth error classification for Google and Microsoft (AC 1)
 * - CalDAV error classification for Apple (AC 2)
 * - Error messages contain zero technical jargon (AC 3)
 * - Retry logic with exponential backoff for transient errors (AC 4)
 * - Persistent errors surface immediately without retry (AC 5)
 * - Error telemetry is anonymized with no PII (AC 6)
 * - Popup blocker detection (AC 7)
 * - OnboardingError carries classified details
 *
 * Uses TDD RED/GREEN/REFACTOR: these tests are written FIRST.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyOAuthError,
  classifyCalDavError,
  retryWithBackoff,
  calculateBackoffDelay,
  createErrorTelemetryEvent,
  findJargon,
  OnboardingError,
  MAX_RETRIES,
  BASE_DELAY_MS,
  JARGON_TERMS,
  type ClassifiedError,
  type ErrorTelemetryEvent,
} from "./onboarding-errors";

// ---------------------------------------------------------------------------
// OAuth error classification (AC 1)
// ---------------------------------------------------------------------------

describe("classifyOAuthError", () => {
  describe("Google provider", () => {
    it("classifies access_denied as persistent with try_again action", () => {
      const result = classifyOAuthError("access_denied", "google");

      expect(result.severity).toBe("persistent");
      expect(result.recovery_action).toBe("try_again");
      expect(result.message).toMatch(/declined.*permission/i);
      expect(result.message).toMatch(/calendar access/i);
      expect(result.provider).toBe("google");
    });

    it("classifies invalid_grant as persistent", () => {
      const result = classifyOAuthError("invalid_grant", "google");

      expect(result.severity).toBe("persistent");
      expect(result.recovery_action).toBe("try_again");
      expect(result.message).toMatch(/expired|took too long/i);
    });

    it("classifies temporarily_unavailable as transient", () => {
      const result = classifyOAuthError("temporarily_unavailable", "google");

      expect(result.severity).toBe("transient");
      expect(result.recovery_action).toBe("wait_and_retry");
      expect(result.message).toMatch(/google.*temporarily unavailable/i);
    });

    it("classifies server_error as transient", () => {
      const result = classifyOAuthError("server_error", "google");

      expect(result.severity).toBe("transient");
      expect(result.message).toMatch(/google.*temporarily unavailable/i);
    });

    it("classifies network_timeout as transient", () => {
      const result = classifyOAuthError("network_timeout", "google");

      expect(result.severity).toBe("transient");
      expect(result.recovery_action).toBe("try_again");
      expect(result.message).toMatch(/connection lost/i);
    });

    it("classifies popup_blocked as persistent with allow_popups action", () => {
      const result = classifyOAuthError("popup_blocked", "google");

      expect(result.severity).toBe("persistent");
      expect(result.recovery_action).toBe("allow_popups");
      expect(result.message).toMatch(/browser.*blocked.*sign-in/i);
      expect(result.recovery_label).toMatch(/allow popups/i);
    });

    it("classifies state_mismatch as persistent with start_over action", () => {
      const result = classifyOAuthError("state_mismatch", "google");

      expect(result.severity).toBe("persistent");
      expect(result.recovery_action).toBe("start_over");
      expect(result.message).toMatch(/something went wrong/i);
    });

    it("classifies unknown errors as persistent with generic message", () => {
      const result = classifyOAuthError("unknown_error_xyz", "google");

      expect(result.severity).toBe("persistent");
      expect(result.recovery_action).toBe("try_again");
      expect(result.message).toMatch(/something went wrong/i);
    });
  });

  describe("Microsoft provider", () => {
    it("classifies temporarily_unavailable with Microsoft name", () => {
      const result = classifyOAuthError("temporarily_unavailable", "microsoft");

      expect(result.severity).toBe("transient");
      expect(result.message).toMatch(/microsoft.*temporarily unavailable/i);
      expect(result.provider).toBe("microsoft");
    });

    it("classifies access_denied the same as Google", () => {
      const result = classifyOAuthError("access_denied", "microsoft");

      expect(result.severity).toBe("persistent");
      expect(result.message).toMatch(/declined.*permission/i);
    });

    it("classifies popup_blocked correctly for Microsoft", () => {
      const result = classifyOAuthError("popup_blocked", "microsoft");

      expect(result.severity).toBe("persistent");
      expect(result.recovery_action).toBe("allow_popups");
    });
  });

  describe("all classified errors have required fields", () => {
    const errorCodes = [
      "access_denied",
      "invalid_grant",
      "temporarily_unavailable",
      "server_error",
      "network_timeout",
      "popup_blocked",
      "state_mismatch",
      "some_unknown_code",
    ];

    for (const code of errorCodes) {
      it(`${code} has code, message, severity, recovery_action, recovery_label, provider`, () => {
        const result = classifyOAuthError(code, "google");

        expect(result.code).toBe(code);
        expect(result.message).toBeTruthy();
        expect(result.severity).toMatch(/^(transient|persistent)$/);
        expect(result.recovery_action).toBeTruthy();
        expect(result.recovery_label).toBeTruthy();
        expect(result.provider).toBe("google");
      });
    }
  });
});

// ---------------------------------------------------------------------------
// CalDAV error classification (AC 2)
// ---------------------------------------------------------------------------

describe("classifyCalDavError", () => {
  it("classifies invalid_password as persistent with show_how action", () => {
    const result = classifyCalDavError("invalid_password");

    expect(result.severity).toBe("persistent");
    expect(result.recovery_action).toBe("show_how");
    expect(result.message).toMatch(/password.*didn.?t work/i);
    expect(result.message).toMatch(/appleid\.apple\.com/i);
    expect(result.provider).toBe("apple");
  });

  it("classifies two_factor_required as persistent with try_again action", () => {
    const result = classifyCalDavError("two_factor_required");

    expect(result.severity).toBe("persistent");
    expect(result.recovery_action).toBe("try_again");
    expect(result.message).toMatch(/additional verification/i);
    expect(result.message).toMatch(/apple device/i);
  });

  it("classifies connection_refused as transient with wait_and_retry action", () => {
    const result = classifyCalDavError("connection_refused");

    expect(result.severity).toBe("transient");
    expect(result.recovery_action).toBe("wait_and_retry");
    expect(result.message).toMatch(/can.?t reach.*apple.*calendar server/i);
    expect(result.message).toMatch(/temporary/i);
  });

  it("classifies auth_failed as persistent", () => {
    const result = classifyCalDavError("auth_failed");

    expect(result.severity).toBe("persistent");
    expect(result.message).toMatch(/unable to sign in/i);
  });

  it("classifies network_timeout as transient", () => {
    const result = classifyCalDavError("network_timeout");

    expect(result.severity).toBe("transient");
    expect(result.message).toMatch(/connection lost/i);
  });

  it("classifies unknown errors as persistent with generic message", () => {
    const result = classifyCalDavError("unknown_caldav_error");

    expect(result.severity).toBe("persistent");
    expect(result.message).toMatch(/something went wrong/i);
    expect(result.provider).toBe("apple");
  });

  describe("all classified errors have required fields", () => {
    const errorCodes = [
      "invalid_password",
      "two_factor_required",
      "connection_refused",
      "auth_failed",
      "network_timeout",
      "some_unknown_code",
    ];

    for (const code of errorCodes) {
      it(`${code} has code, message, severity, recovery_action, recovery_label, provider`, () => {
        const result = classifyCalDavError(code);

        expect(result.code).toBe(code);
        expect(result.message).toBeTruthy();
        expect(result.severity).toMatch(/^(transient|persistent)$/);
        expect(result.recovery_action).toBeTruthy();
        expect(result.recovery_label).toBeTruthy();
        expect(result.provider).toBe("apple");
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Error messages contain zero technical jargon (AC 3)
// ---------------------------------------------------------------------------

describe("jargon-free error messages", () => {
  const oauthCodes = [
    "access_denied",
    "invalid_grant",
    "temporarily_unavailable",
    "server_error",
    "network_timeout",
    "popup_blocked",
    "state_mismatch",
  ];

  const caldavCodes = [
    "invalid_password",
    "two_factor_required",
    "connection_refused",
    "auth_failed",
    "network_timeout",
  ];

  for (const code of oauthCodes) {
    it(`OAuth error "${code}" message has no jargon`, () => {
      const result = classifyOAuthError(code, "google");
      const jargon = findJargon(result.message);
      expect(jargon).toEqual([]);
    });

    it(`OAuth error "${code}" recovery_label has no jargon`, () => {
      const result = classifyOAuthError(code, "google");
      const jargon = findJargon(result.recovery_label);
      expect(jargon).toEqual([]);
    });
  }

  for (const code of caldavCodes) {
    it(`CalDAV error "${code}" message has no jargon`, () => {
      const result = classifyCalDavError(code);
      const jargon = findJargon(result.message);
      expect(jargon).toEqual([]);
    });

    it(`CalDAV error "${code}" recovery_label has no jargon`, () => {
      const result = classifyCalDavError(code);
      const jargon = findJargon(result.recovery_label);
      expect(jargon).toEqual([]);
    });
  }
});

describe("findJargon", () => {
  it("returns empty array for clean text", () => {
    expect(findJargon("Please try again")).toEqual([]);
  });

  it("detects OAuth in text", () => {
    expect(findJargon("OAuth error occurred")).toContain("oauth");
  });

  it("detects token in text", () => {
    expect(findJargon("Your token expired")).toContain("token");
  });

  it("detects HTTP status codes", () => {
    expect(findJargon("Got a 401 error")).toContain("401");
  });

  it("detects PKCE", () => {
    expect(findJargon("PKCE challenge failed")).toContain("pkce");
  });

  it("detects PROPFIND", () => {
    expect(findJargon("PROPFIND returned error")).toContain("propfind");
  });

  it("is case-insensitive", () => {
    expect(findJargon("OAUTH ERROR")).toContain("oauth");
  });

  it("detects multiple jargon terms", () => {
    const result = findJargon("OAuth token scope error");
    expect(result).toContain("oauth");
    expect(result).toContain("token");
    expect(result).toContain("scope");
  });
});

// ---------------------------------------------------------------------------
// Retry logic with exponential backoff (AC 4)
// ---------------------------------------------------------------------------

describe("calculateBackoffDelay", () => {
  it("returns approximately base delay for attempt 0", () => {
    // With jitter, should be within 25% of base delay
    const delay = calculateBackoffDelay(0, 1000);
    expect(delay).toBeGreaterThanOrEqual(750);
    expect(delay).toBeLessThanOrEqual(1250);
  });

  it("returns approximately 2x base delay for attempt 1", () => {
    const delay = calculateBackoffDelay(1, 1000);
    expect(delay).toBeGreaterThanOrEqual(1500);
    expect(delay).toBeLessThanOrEqual(2500);
  });

  it("returns approximately 4x base delay for attempt 2", () => {
    const delay = calculateBackoffDelay(2, 1000);
    expect(delay).toBeGreaterThanOrEqual(3000);
    expect(delay).toBeLessThanOrEqual(5000);
  });

  it("uses BASE_DELAY_MS as default", () => {
    const delay = calculateBackoffDelay(0);
    expect(delay).toBeGreaterThanOrEqual(BASE_DELAY_MS * 0.75);
    expect(delay).toBeLessThanOrEqual(BASE_DELAY_MS * 1.25);
  });
});

describe("retryWithBackoff", () => {
  const immediateDelay = async (_ms: number) => {};

  it("returns result on first success without retrying", async () => {
    const operation = vi.fn(async () => "success");
    const classify = vi.fn();

    const result = await retryWithBackoff(
      operation,
      classify,
      MAX_RETRIES,
      undefined,
      immediateDelay,
    );

    expect(result).toBe("success");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(classify).not.toHaveBeenCalled();
  });

  it("retries transient errors up to MAX_RETRIES times", async () => {
    let callCount = 0;
    const operation = vi.fn(async () => {
      callCount++;
      if (callCount <= MAX_RETRIES) {
        throw new Error("transient failure");
      }
      return "eventual success";
    });

    const transientClassification: ClassifiedError = {
      code: "network_timeout",
      message: "Connection lost",
      severity: "transient",
      recovery_action: "try_again",
      recovery_label: "Try again",
      provider: "google",
    };
    const classify = vi.fn(() => transientClassification);

    const result = await retryWithBackoff(
      operation,
      classify,
      MAX_RETRIES,
      undefined,
      immediateDelay,
    );

    expect(result).toBe("eventual success");
    // 1 initial + MAX_RETRIES retries = MAX_RETRIES + 1 total calls
    expect(operation).toHaveBeenCalledTimes(MAX_RETRIES + 1);
  });

  it("throws OnboardingError for persistent errors immediately (no retry)", async () => {
    const operation = vi.fn(async () => {
      throw new Error("access denied");
    });

    const persistentClassification: ClassifiedError = {
      code: "access_denied",
      message: "You declined the permission",
      severity: "persistent",
      recovery_action: "try_again",
      recovery_label: "Try again",
      provider: "google",
    };
    const classify = vi.fn(() => persistentClassification);

    await expect(
      retryWithBackoff(operation, classify, MAX_RETRIES, undefined, immediateDelay),
    ).rejects.toThrow(OnboardingError);

    // Should only call once -- no retries for persistent errors
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("throws OnboardingError when all retries exhausted for transient errors", async () => {
    const operation = vi.fn(async () => {
      throw new Error("always fails");
    });

    const transientClassification: ClassifiedError = {
      code: "network_timeout",
      message: "Connection lost",
      severity: "transient",
      recovery_action: "try_again",
      recovery_label: "Try again",
      provider: "google",
    };
    const classify = vi.fn(() => transientClassification);

    await expect(
      retryWithBackoff(operation, classify, MAX_RETRIES, undefined, immediateDelay),
    ).rejects.toThrow(OnboardingError);

    // 1 initial + MAX_RETRIES retries
    expect(operation).toHaveBeenCalledTimes(MAX_RETRIES + 1);
  });

  it("calls onRetry callback before each retry attempt", async () => {
    let callCount = 0;
    const operation = vi.fn(async () => {
      callCount++;
      if (callCount <= 2) throw new Error("fail");
      return "ok";
    });

    const transientClassification: ClassifiedError = {
      code: "network_timeout",
      message: "Connection lost",
      severity: "transient",
      recovery_action: "try_again",
      recovery_label: "Try again",
      provider: "google",
    };
    const classify = vi.fn(() => transientClassification);
    const onRetry = vi.fn();

    await retryWithBackoff(operation, classify, MAX_RETRIES, onRetry, immediateDelay);

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(0, transientClassification);
    expect(onRetry).toHaveBeenCalledWith(1, transientClassification);
  });

  it("OnboardingError carries the classified error details", async () => {
    const operation = vi.fn(async () => {
      throw new Error("denied");
    });

    const classification: ClassifiedError = {
      code: "access_denied",
      message: "You declined the permission",
      severity: "persistent",
      recovery_action: "try_again",
      recovery_label: "Try again",
      provider: "google",
    };
    const classify = vi.fn(() => classification);

    try {
      await retryWithBackoff(operation, classify, MAX_RETRIES, undefined, immediateDelay);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OnboardingError);
      const onboardingErr = err as OnboardingError;
      expect(onboardingErr.classified).toEqual(classification);
      expect(onboardingErr.message).toBe("You declined the permission");
    }
  });
});

// ---------------------------------------------------------------------------
// OnboardingError
// ---------------------------------------------------------------------------

describe("OnboardingError", () => {
  it("extends Error", () => {
    const classified: ClassifiedError = {
      code: "test",
      message: "Test error",
      severity: "persistent",
      recovery_action: "try_again",
      recovery_label: "Try again",
      provider: "google",
    };
    const err = new OnboardingError(classified);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("OnboardingError");
    expect(err.message).toBe("Test error");
    expect(err.classified).toBe(classified);
  });
});

// ---------------------------------------------------------------------------
// Error telemetry (AC 6)
// ---------------------------------------------------------------------------

describe("createErrorTelemetryEvent", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-02-15T12:00:00Z").getTime() });
  });

  it("creates anonymized telemetry event with required fields", () => {
    const classified: ClassifiedError = {
      code: "access_denied",
      message: "You declined the permission",
      severity: "persistent",
      recovery_action: "try_again",
      recovery_label: "Try again",
      provider: "google",
    };

    const event = createErrorTelemetryEvent(classified);

    expect(event.provider).toBe("google");
    expect(event.error_type).toBe("access_denied");
    expect(event.severity).toBe("persistent");
    expect(event.timestamp).toBe("2026-02-15T12:00:00.000Z");
  });

  it("includes retry_count when provided", () => {
    const classified: ClassifiedError = {
      code: "network_timeout",
      message: "Connection lost",
      severity: "transient",
      recovery_action: "try_again",
      recovery_label: "Try again",
      provider: "google",
    };

    const event = createErrorTelemetryEvent(classified, { retry_count: 2 });

    expect(event.retry_count).toBe(2);
  });

  it("omits retry_count when not provided (key absent, not false)", () => {
    const classified: ClassifiedError = {
      code: "access_denied",
      message: "You declined the permission",
      severity: "persistent",
      recovery_action: "try_again",
      recovery_label: "Try again",
      provider: "google",
    };

    const event = createErrorTelemetryEvent(classified);

    // Key should not exist at all (not false, not 0, not null)
    expect("retry_count" in event).toBe(false);
  });

  it("includes recovered when provided", () => {
    const classified: ClassifiedError = {
      code: "network_timeout",
      message: "Connection lost",
      severity: "transient",
      recovery_action: "try_again",
      recovery_label: "Try again",
      provider: "google",
    };

    const event = createErrorTelemetryEvent(classified, { recovered: true });
    expect(event.recovered).toBe(true);
  });

  it("omits recovered when not provided", () => {
    const classified: ClassifiedError = {
      code: "access_denied",
      message: "msg",
      severity: "persistent",
      recovery_action: "try_again",
      recovery_label: "label",
      provider: "google",
    };

    const event = createErrorTelemetryEvent(classified);
    expect("recovered" in event).toBe(false);
  });

  it("includes user_dismissed when provided", () => {
    const classified: ClassifiedError = {
      code: "access_denied",
      message: "msg",
      severity: "persistent",
      recovery_action: "try_again",
      recovery_label: "label",
      provider: "google",
    };

    const event = createErrorTelemetryEvent(classified, { user_dismissed: true });
    expect(event.user_dismissed).toBe(true);
  });

  it("omits user_dismissed when not provided", () => {
    const classified: ClassifiedError = {
      code: "access_denied",
      message: "msg",
      severity: "persistent",
      recovery_action: "try_again",
      recovery_label: "label",
      provider: "google",
    };

    const event = createErrorTelemetryEvent(classified);
    expect("user_dismissed" in event).toBe(false);
  });

  it("contains NO PII fields (no email, no token, no user_id)", () => {
    const classified: ClassifiedError = {
      code: "access_denied",
      message: "You declined the permission",
      severity: "persistent",
      recovery_action: "try_again",
      recovery_label: "Try again",
      provider: "google",
    };

    const event = createErrorTelemetryEvent(classified, {
      retry_count: 1,
      recovered: false,
      user_dismissed: false,
    });

    // Verify the telemetry event shape has NO PII fields
    const keys = Object.keys(event);
    expect(keys).not.toContain("email");
    expect(keys).not.toContain("user_id");
    expect(keys).not.toContain("token");
    expect(keys).not.toContain("access_token");
    expect(keys).not.toContain("refresh_token");
    expect(keys).not.toContain("password");

    // Verify the serialized JSON contains no email patterns
    const json = JSON.stringify(event);
    expect(json).not.toMatch(/@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  });

  it("retry_count=0 is distinct from omitted (retro learning)", () => {
    const classified: ClassifiedError = {
      code: "network_timeout",
      message: "Connection lost",
      severity: "transient",
      recovery_action: "try_again",
      recovery_label: "Try again",
      provider: "google",
    };

    const withZero = createErrorTelemetryEvent(classified, { retry_count: 0 });
    const withoutRetry = createErrorTelemetryEvent(classified);

    // retry_count=0 means "zero retries attempted" -- key IS present
    expect("retry_count" in withZero).toBe(true);
    expect(withZero.retry_count).toBe(0);

    // Omitted means "not applicable" -- key is NOT present
    expect("retry_count" in withoutRetry).toBe(false);
  });

  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("MAX_RETRIES is 3", () => {
    expect(MAX_RETRIES).toBe(3);
  });

  it("BASE_DELAY_MS is reasonable (500-2000ms)", () => {
    expect(BASE_DELAY_MS).toBeGreaterThanOrEqual(500);
    expect(BASE_DELAY_MS).toBeLessThanOrEqual(2000);
  });

  it("JARGON_TERMS is a non-empty list of lowercase terms", () => {
    expect(JARGON_TERMS.length).toBeGreaterThan(10);
    for (const term of JARGON_TERMS) {
      expect(term).toBe(term.toLowerCase());
    }
  });
});
