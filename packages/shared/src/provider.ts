/**
 * @tminus/shared -- Provider-agnostic calendar abstraction layer.
 *
 * Defines the ProviderType union, CalendarProvider interface re-export,
 * ClassificationStrategy interface, normalization dispatch, and a
 * provider factory for constructing providers by type.
 *
 * This module is the single entry point for all provider-agnostic code.
 * Google-specific implementations are in google-api.ts, normalize.ts, etc.
 * Future providers (Microsoft, CalDAV) will follow the same pattern.
 */

import type {
  GoogleCalendarEvent,
  EventClassification,
  AccountId,
  ProviderDelta,
} from "./types";
import type { CalendarProvider, FetchFn } from "./google-api";
import { GoogleCalendarClient } from "./google-api";
import { normalizeGoogleEvent } from "./normalize";
import { classifyEvent as classifyGoogleEvent } from "./classify";

// ---------------------------------------------------------------------------
// Provider type
// ---------------------------------------------------------------------------

/**
 * Supported calendar provider types.
 * 'google' is the only provider in Phase 1.
 * 'microsoft' and 'caldav' are reserved for Phase 5.
 */
export type ProviderType = "google" | "microsoft" | "caldav";

/**
 * All currently supported provider types.
 * Useful for validation and iteration.
 */
export const SUPPORTED_PROVIDERS: readonly ProviderType[] = ["google"] as const;

/**
 * Check if a string is a valid ProviderType.
 * Only currently supported (implemented) providers return true.
 */
export function isSupportedProvider(value: string): value is ProviderType {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Classification strategy
// ---------------------------------------------------------------------------

/**
 * Provider-specific event classification strategy.
 *
 * Each provider may use different mechanisms to identify managed mirrors.
 * Google uses extended properties; Microsoft may use extensions or categories.
 *
 * The strategy accepts a raw provider event (typed as `unknown` since each
 * provider has its own event shape) and returns an EventClassification.
 */
export interface ClassificationStrategy {
  /**
   * Classify a raw provider event into an EventClassification.
   * Must be a pure function -- no side effects, deterministic.
   */
  classify(rawEvent: unknown): EventClassification;
}

/**
 * Google Calendar classification strategy.
 * Wraps the existing classifyEvent function as a ClassificationStrategy.
 */
export const googleClassificationStrategy: ClassificationStrategy = {
  classify(rawEvent: unknown): EventClassification {
    return classifyGoogleEvent(rawEvent as GoogleCalendarEvent);
  },
};

/**
 * Get the ClassificationStrategy for a given provider type.
 * Throws if the provider is not supported.
 */
export function getClassificationStrategy(
  provider: ProviderType,
): ClassificationStrategy {
  switch (provider) {
    case "google":
      return googleClassificationStrategy;
    default:
      throw new Error(
        `No classification strategy for provider: ${provider}. Only Google is supported in Phase 1.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Provider-agnostic normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw provider event into a ProviderDelta.
 *
 * Dispatches to the correct provider-specific normalizer based on
 * the provider type. This is the single entry point for normalization
 * in the sync pipeline.
 *
 * @param provider - The provider type (e.g., 'google')
 * @param rawEvent - Raw event from the provider API (shape varies by provider)
 * @param accountId - The account this event belongs to
 * @param classification - How the event was classified
 * @returns A ProviderDelta ready for the sync pipeline
 */
export function normalizeProviderEvent(
  provider: ProviderType,
  rawEvent: unknown,
  accountId: AccountId,
  classification: EventClassification,
): ProviderDelta {
  switch (provider) {
    case "google":
      return normalizeGoogleEvent(
        rawEvent as GoogleCalendarEvent,
        accountId,
        classification,
      );
    default:
      throw new Error(
        `No normalizer for provider: ${provider}. Only Google is supported in Phase 1.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Create a CalendarProvider for the given provider type.
 *
 * @param provider - The provider type
 * @param accessToken - OAuth access token for the provider
 * @param fetchFn - Optional injectable fetch function (for testing)
 * @returns A CalendarProvider instance
 */
export function createCalendarProvider(
  provider: ProviderType,
  accessToken: string,
  fetchFn?: FetchFn,
): CalendarProvider {
  switch (provider) {
    case "google":
      return new GoogleCalendarClient(accessToken, fetchFn);
    default:
      throw new Error(
        `Cannot create provider: ${provider}. Only Google is supported in Phase 1.`,
      );
  }
}
