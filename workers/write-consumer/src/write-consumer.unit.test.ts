/**
 * Unit tests for write-consumer error classification and retry strategy.
 *
 * Focuses on the classifyError function that maps Google API errors
 * to retry strategies.
 */

import { describe, it, expect } from "vitest";
import {
  GoogleApiError,
  TokenExpiredError,
  RateLimitError,
  ResourceNotFoundError,
  SyncTokenExpiredError,
  MicrosoftApiError,
  MicrosoftTokenExpiredError,
  MicrosoftRateLimitError,
  MicrosoftResourceNotFoundError,
} from "@tminus/shared";
import { classifyError } from "./write-consumer";

describe("classifyError", () => {
  it("429 RateLimitError: retry with max 5", () => {
    const result = classifyError(new RateLimitError());
    expect(result.shouldRetry).toBe(true);
    expect(result.maxRetries).toBe(5);
  });

  it("401 TokenExpiredError: retry with max 1", () => {
    const result = classifyError(new TokenExpiredError());
    expect(result.shouldRetry).toBe(true);
    expect(result.maxRetries).toBe(1);
  });

  it("500 GoogleApiError: retry with max 3", () => {
    const result = classifyError(new GoogleApiError("Internal error", 500));
    expect(result.shouldRetry).toBe(true);
    expect(result.maxRetries).toBe(3);
  });

  it("503 GoogleApiError: retry with max 3", () => {
    const result = classifyError(new GoogleApiError("Service unavailable", 503));
    expect(result.shouldRetry).toBe(true);
    expect(result.maxRetries).toBe(3);
  });

  it("403 GoogleApiError: no retry (permanent)", () => {
    const result = classifyError(new GoogleApiError("Forbidden", 403));
    expect(result.shouldRetry).toBe(false);
    expect(result.maxRetries).toBe(0);
  });

  it("403 GoogleApiError rate-limit: retry with max 5", () => {
    const result = classifyError(new GoogleApiError("Rate Limit Exceeded", 403));
    expect(result.shouldRetry).toBe(true);
    expect(result.maxRetries).toBe(5);
  });

  it("404 ResourceNotFoundError: no retry (permanent)", () => {
    const result = classifyError(new ResourceNotFoundError());
    expect(result.shouldRetry).toBe(false);
    expect(result.maxRetries).toBe(0);
  });

  it("410 SyncTokenExpiredError: no retry (permanent)", () => {
    const result = classifyError(new SyncTokenExpiredError());
    expect(result.shouldRetry).toBe(false);
    expect(result.maxRetries).toBe(0);
  });

  it("other GoogleApiError (e.g. 400): no retry", () => {
    const result = classifyError(new GoogleApiError("Bad request", 400));
    expect(result.shouldRetry).toBe(false);
    expect(result.maxRetries).toBe(0);
  });

  it("no tokens stored error: no retry (permanent)", () => {
    const result = classifyError(
      new Error('AccountDO.getAccessToken failed (500): {"error":"AccountDO: no tokens stored. Call initialize() first."}'),
    );
    expect(result.shouldRetry).toBe(false);
    expect(result.maxRetries).toBe(0);
  });

  it("invalid_grant refresh failure: no retry (relink required)", () => {
    const result = classifyError(
      new Error('AccountDO.getAccessToken failed (500): {"error":"Token refresh failed (400): {\\"error\\":\\"invalid_grant\\"}"}'),
    );
    expect(result.shouldRetry).toBe(false);
    expect(result.maxRetries).toBe(0);
  });

  it("unknown Error: retry with max 1", () => {
    const result = classifyError(new Error("Something went wrong"));
    expect(result.shouldRetry).toBe(true);
    expect(result.maxRetries).toBe(1);
  });

  it("string error: retry with max 1", () => {
    const result = classifyError("network failure");
    expect(result.shouldRetry).toBe(true);
    expect(result.maxRetries).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Microsoft error classification
  // -------------------------------------------------------------------------

  it("Microsoft 429 MicrosoftRateLimitError: retry with max 5", () => {
    const result = classifyError(new MicrosoftRateLimitError());
    expect(result.shouldRetry).toBe(true);
    expect(result.maxRetries).toBe(5);
  });

  it("Microsoft 401 MicrosoftTokenExpiredError: retry with max 1", () => {
    const result = classifyError(new MicrosoftTokenExpiredError());
    expect(result.shouldRetry).toBe(true);
    expect(result.maxRetries).toBe(1);
  });

  it("Microsoft 500 MicrosoftApiError: retry with max 3", () => {
    const result = classifyError(new MicrosoftApiError("Internal error", 500));
    expect(result.shouldRetry).toBe(true);
    expect(result.maxRetries).toBe(3);
  });

  it("Microsoft 503 MicrosoftApiError: retry with max 3", () => {
    const result = classifyError(new MicrosoftApiError("Service unavailable", 503));
    expect(result.shouldRetry).toBe(true);
    expect(result.maxRetries).toBe(3);
  });

  it("Microsoft 403 MicrosoftApiError: no retry (permanent)", () => {
    const result = classifyError(new MicrosoftApiError("Forbidden", 403));
    expect(result.shouldRetry).toBe(false);
    expect(result.maxRetries).toBe(0);
  });

  it("Microsoft 404 MicrosoftResourceNotFoundError: no retry (permanent)", () => {
    const result = classifyError(new MicrosoftResourceNotFoundError());
    expect(result.shouldRetry).toBe(false);
    expect(result.maxRetries).toBe(0);
  });
});
