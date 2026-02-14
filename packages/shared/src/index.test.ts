import { describe, it, expect } from "vitest";
import {
  APP_NAME,
  SCHEMA_VERSION,
  GoogleCalendarClient,
  GoogleApiError,
  TokenExpiredError,
  ResourceNotFoundError,
  SyncTokenExpiredError,
  RateLimitError,
  SUPPORTED_PROVIDERS,
  isSupportedProvider,
  googleClassificationStrategy,
  getClassificationStrategy,
  normalizeProviderEvent,
  createCalendarProvider,
} from "./index";

describe("@tminus/shared", () => {
  it("exports APP_NAME as tminus", () => {
    expect(APP_NAME).toBe("tminus");
  });

  it("exports SCHEMA_VERSION as a positive integer", () => {
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
  });

  it("exports Google Calendar API abstraction classes", () => {
    expect(GoogleCalendarClient).toBeDefined();
    expect(GoogleApiError).toBeDefined();
    expect(TokenExpiredError).toBeDefined();
    expect(ResourceNotFoundError).toBeDefined();
    expect(SyncTokenExpiredError).toBeDefined();
    expect(RateLimitError).toBeDefined();
  });

  it("exports provider-agnostic abstraction functions", () => {
    expect(SUPPORTED_PROVIDERS).toBeDefined();
    expect(isSupportedProvider).toBeDefined();
    expect(googleClassificationStrategy).toBeDefined();
    expect(getClassificationStrategy).toBeDefined();
    expect(normalizeProviderEvent).toBeDefined();
    expect(createCalendarProvider).toBeDefined();
  });
});
