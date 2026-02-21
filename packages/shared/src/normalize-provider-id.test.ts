/**
 * Unit tests for canonicalizeProviderEventId.
 *
 * Covers: plain IDs, URL-encoded, double-encoded, partial encoding,
 * special characters, empty string, and malformed sequences.
 */

import { describe, it, expect } from "vitest";
import { canonicalizeProviderEventId } from "./normalize-provider-id";

describe("canonicalizeProviderEventId", () => {
  it("returns a plain ID unchanged", () => {
    expect(canonicalizeProviderEventId("abc123")).toBe("abc123");
  });

  it("returns an ID with no percent sequences unchanged", () => {
    expect(canonicalizeProviderEventId("event_with_underscores")).toBe(
      "event_with_underscores",
    );
  });

  it("decodes a single-encoded ID", () => {
    // "hello world" encoded once
    expect(canonicalizeProviderEventId("hello%20world")).toBe("hello world");
  });

  it("decodes a double-encoded ID", () => {
    // "hello world" -> "hello%20world" -> "hello%2520world"
    expect(canonicalizeProviderEventId("hello%2520world")).toBe("hello world");
  });

  it("decodes a triple-encoded ID", () => {
    // "hello world" -> "hello%20world" -> "hello%2520world" -> "hello%252520world"
    expect(canonicalizeProviderEventId("hello%252520world")).toBe("hello world");
  });

  it("decodes a single-encoded slash", () => {
    // Google Calendar commonly returns event IDs with encoded slashes
    expect(canonicalizeProviderEventId("abc%2Fdef")).toBe("abc/def");
  });

  it("decodes a double-encoded slash", () => {
    expect(canonicalizeProviderEventId("abc%252Fdef")).toBe("abc/def");
  });

  it("decodes a realistic Google Calendar event ID with encoding", () => {
    // Google Calendar recurring event IDs contain underscores and sometimes encoding
    const encoded = "event123_R20260215T090000%40google.com";
    expect(canonicalizeProviderEventId(encoded)).toBe(
      "event123_R20260215T090000@google.com",
    );
  });

  it("decodes a double-encoded Google Calendar event ID", () => {
    const doubleEncoded = "event123_R20260215T090000%2540google.com";
    expect(canonicalizeProviderEventId(doubleEncoded)).toBe(
      "event123_R20260215T090000@google.com",
    );
  });

  it("handles partial encoding (some chars encoded, some not)", () => {
    // "a@b/c" partially encoded as "a%40b/c"
    expect(canonicalizeProviderEventId("a%40b/c")).toBe("a@b/c");
  });

  it("handles special characters in IDs", () => {
    // Characters that are common in provider IDs: @, /, +, =
    const encoded = "%40%2F%2B%3D";
    expect(canonicalizeProviderEventId(encoded)).toBe("@/+=");
  });

  it("returns empty string as-is", () => {
    expect(canonicalizeProviderEventId("")).toBe("");
  });

  it("handles malformed percent sequences gracefully", () => {
    // "%ZZ" is not a valid percent-encoded sequence; decodeURIComponent will throw
    // The function should return the input as-is (or partially decoded)
    const result = canonicalizeProviderEventId("%ZZ");
    // Should not throw, and should return the original malformed input
    expect(result).toBe("%ZZ");
  });

  it("handles partially malformed sequences after valid decoding", () => {
    // decodeURIComponent is atomic: if ANY sequence in the string is invalid,
    // the entire call throws. So "valid%2520then%ZZbad" cannot be decoded at
    // all because "%ZZ" is malformed. The function breaks on the first attempt
    // and returns the original input unchanged.
    const result = canonicalizeProviderEventId("valid%2520then%ZZbad");
    expect(result).toBe("valid%2520then%ZZbad");
  });

  it("is idempotent -- calling twice gives the same result", () => {
    const input = "hello%2520world";
    const once = canonicalizeProviderEventId(input);
    const twice = canonicalizeProviderEventId(once);
    expect(once).toBe(twice);
    expect(twice).toBe("hello world");
  });

  it("handles Microsoft Graph style event IDs (base64-like, no encoding)", () => {
    // Microsoft uses long base64-like IDs that contain no percent encoding
    const msId =
      "AAMkADQ2YjAxMGI0LWFiNjgtNGI5Ni05ODJkLWNjODIzMzc0ZDUyZgBGAAAAAADHBF";
    expect(canonicalizeProviderEventId(msId)).toBe(msId);
  });

  it("handles IDs with unicode characters already decoded", () => {
    // Unicode chars that are not percent-encoded should pass through
    const unicodeId = "meeting-cafe-reunion";
    expect(canonicalizeProviderEventId(unicodeId)).toBe(unicodeId);
  });

  it("handles IDs with encoded unicode (multi-byte)", () => {
    // The e-acute in "cafe" is U+00E9, encoded as %C3%A9 in UTF-8
    const encoded = "caf%C3%A9";
    expect(canonicalizeProviderEventId(encoded)).toBe("caf\u00e9");
  });

  it("normalizes all encoding variants to the same canonical form", () => {
    // This is the core invariant: regardless of encoding depth,
    // all variants of the same logical ID produce the same canonical form
    const plain = "event@calendar/2026";
    const singleEncoded = "event%40calendar%2F2026";
    const doubleEncoded = "event%2540calendar%252F2026";

    const canonical1 = canonicalizeProviderEventId(plain);
    const canonical2 = canonicalizeProviderEventId(singleEncoded);
    const canonical3 = canonicalizeProviderEventId(doubleEncoded);

    expect(canonical1).toBe(plain);
    expect(canonical2).toBe(plain);
    expect(canonical3).toBe(plain);
  });
});
