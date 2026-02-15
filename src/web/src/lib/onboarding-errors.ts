/**
 * Onboarding error classification, retry logic, and telemetry.
 *
 * Maps every OAuth and CalDAV error response to a user-facing category
 * with jargon-free messages and actionable recovery paths.
 *
 * Design:
 * - Every error is classified as "transient" or "persistent"
 * - Transient errors auto-retry up to MAX_RETRIES with exponential backoff
 * - Persistent errors surface to the user with a manual retry button
 * - Error telemetry is anonymized (no PII: no tokens, no email addresses)
 * - Optional telemetry fields use `field?: type` (not `field: type | false`)
 *   per retro learning on undefined-vs-false ambiguity
 *
 * Business rules:
 * - BR-1: Every error has a user-facing message and a recovery action
 * - BR-2: No technical jargon (no "PKCE", "state parameter", "401", "PROPFIND")
 * - BR-3: Transient errors auto-retry silently; persistent errors surface to user
 * - BR-4: Error telemetry is anonymized (no PII)
 */

import type { AccountProvider } from "./api";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of automatic retries for transient errors. */
export const MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential backoff. */
export const BASE_DELAY_MS = 1000;

/** Jargon terms that must never appear in user-facing error messages. */
export const JARGON_TERMS = [
  "pkce",
  "state parameter",
  "401",
  "403",
  "404",
  "500",
  "502",
  "oauth",
  "token",
  "scope",
  "grant",
  "propfind",
  "caldav",
  "http",
  "https",
  "cors",
  "csrf",
  "nonce",
  "redirect_uri",
  "client_id",
  "client_secret",
  "code_verifier",
  "code_challenge",
  "authorization_code",
  "bearer",
  "jwt",
  "saml",
  "openid",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Whether an error can be automatically retried. */
export type ErrorSeverity = "transient" | "persistent";

/** Recovery action the user can take. */
export type RecoveryAction =
  | "try_again"
  | "start_over"
  | "allow_popups"
  | "show_how"
  | "wait_and_retry";

/** Classified error with user-facing message and recovery path. */
export interface ClassifiedError {
  /** The raw error code or identifier from the provider. */
  code: string;
  /** User-facing message (jargon-free). */
  message: string;
  /** Whether this error can be auto-retried. */
  severity: ErrorSeverity;
  /** The action the user should take. */
  recovery_action: RecoveryAction;
  /** Label for the recovery action button. */
  recovery_label: string;
  /** Which provider produced this error. */
  provider: AccountProvider;
}

/**
 * Anonymized error telemetry event.
 *
 * Per retro learning: optional fields use `field?: type` with key omission
 * so that "not applicable" is distinct from "zero attempts".
 */
export interface ErrorTelemetryEvent {
  /** Provider that produced the error. */
  provider: AccountProvider;
  /** Error category/code (never contains PII). */
  error_type: string;
  /** Whether the error was transient or persistent. */
  severity: ErrorSeverity;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Number of retry attempts before surfacing (omitted for non-retryable errors). */
  retry_count?: number;
  /** Whether the error was eventually recovered from (omitted if still pending). */
  recovered?: boolean;
  /** Whether the user dismissed the error (omitted if not applicable). */
  user_dismissed?: boolean;
}

// ---------------------------------------------------------------------------
// OAuth error classification
// ---------------------------------------------------------------------------

/**
 * Classify an OAuth error response into a user-facing category.
 *
 * Handles:
 * - access_denied: user declined consent
 * - invalid_grant: authorization expired or already used
 * - temporarily_unavailable: provider-side outage
 * - server_error: provider-side error
 * - network_timeout: network connectivity issue
 * - popup_blocked: browser blocked the sign-in window
 * - state_mismatch: CSRF/state validation failed
 * - unknown: catch-all for unrecognized errors
 *
 * @param errorCode - The error code from the OAuth provider or detection logic
 * @param provider - Which provider ("google" or "microsoft")
 * @returns Classified error with user-facing message and recovery action
 */
export function classifyOAuthError(
  errorCode: string,
  provider: AccountProvider,
): ClassifiedError {
  const providerName = provider === "google" ? "Google" : "Microsoft";

  switch (errorCode) {
    case "access_denied":
      return {
        code: errorCode,
        message:
          "You declined the permission. T-Minus needs calendar access to work.",
        severity: "persistent",
        recovery_action: "try_again",
        recovery_label: "Try again",
        provider,
      };

    case "invalid_grant":
      return {
        code: errorCode,
        message:
          "The authorization expired. This happens if you took too long.",
        severity: "persistent",
        recovery_action: "try_again",
        recovery_label: "Try again",
        provider,
      };

    case "temporarily_unavailable":
    case "server_error":
      return {
        code: errorCode,
        message: `${providerName} is temporarily unavailable.`,
        severity: "transient",
        recovery_action: "wait_and_retry",
        recovery_label: "Try again in a few minutes",
        provider,
      };

    case "network_timeout":
      return {
        code: errorCode,
        message: "Connection lost. Check your internet and try again.",
        severity: "transient",
        recovery_action: "try_again",
        recovery_label: "Try again",
        provider,
      };

    case "popup_blocked":
      return {
        code: errorCode,
        message: "Your browser blocked the sign-in window.",
        severity: "persistent",
        recovery_action: "allow_popups",
        recovery_label: "Allow popups for this site",
        provider,
      };

    case "state_mismatch":
      return {
        code: errorCode,
        message: "Something went wrong with the sign-in flow.",
        severity: "persistent",
        recovery_action: "start_over",
        recovery_label: "Start over",
        provider,
      };

    default:
      return {
        code: errorCode,
        message: "Something went wrong. Please try again.",
        severity: "persistent",
        recovery_action: "try_again",
        recovery_label: "Try again",
        provider,
      };
  }
}

// ---------------------------------------------------------------------------
// CalDAV (Apple) error classification
// ---------------------------------------------------------------------------

/**
 * Classify a CalDAV/Apple error into a user-facing category.
 *
 * Handles:
 * - invalid_password: app-specific password incorrect
 * - two_factor_required: Apple requires additional verification
 * - connection_refused: cannot reach Apple's calendar server
 * - auth_failed: generic authentication failure
 * - network_timeout: network connectivity issue
 * - unknown: catch-all
 *
 * @param errorCode - The error code from the CalDAV connection logic
 * @returns Classified error with user-facing message and recovery action
 */
export function classifyCalDavError(errorCode: string): ClassifiedError {
  switch (errorCode) {
    case "invalid_password":
      return {
        code: errorCode,
        message:
          "That password didn't work. Make sure you copied the full password from appleid.apple.com.",
        severity: "persistent",
        recovery_action: "show_how",
        recovery_label: "Show me how",
        provider: "apple",
      };

    case "two_factor_required":
      return {
        code: errorCode,
        message:
          "Apple requires additional verification. Complete it on your Apple device, then try again.",
        severity: "persistent",
        recovery_action: "try_again",
        recovery_label: "Try again",
        provider: "apple",
      };

    case "connection_refused":
      return {
        code: errorCode,
        message:
          "Can't reach Apple's calendar server. This may be a temporary issue.",
        severity: "transient",
        recovery_action: "wait_and_retry",
        recovery_label: "Try again in a few minutes",
        provider: "apple",
      };

    case "auth_failed":
      return {
        code: errorCode,
        message:
          "Unable to sign in with those credentials. Please double-check your Apple ID email and app-specific password.",
        severity: "persistent",
        recovery_action: "try_again",
        recovery_label: "Try again",
        provider: "apple",
      };

    case "network_timeout":
      return {
        code: errorCode,
        message: "Connection lost. Check your internet and try again.",
        severity: "transient",
        recovery_action: "try_again",
        recovery_label: "Try again",
        provider: "apple",
      };

    default:
      return {
        code: errorCode,
        message: "Something went wrong connecting to Apple Calendar. Please try again.",
        severity: "persistent",
        recovery_action: "try_again",
        recovery_label: "Try again",
        provider: "apple",
      };
  }
}

// ---------------------------------------------------------------------------
// Retry logic with exponential backoff
// ---------------------------------------------------------------------------

/**
 * Calculate the delay for an exponential backoff retry.
 *
 * delay = BASE_DELAY_MS * 2^attempt (0-indexed)
 * With jitter: +/- 25% randomization to avoid thundering herd.
 *
 * @param attempt - The retry attempt number (0-indexed)
 * @param baseDelay - Base delay in milliseconds (default: BASE_DELAY_MS)
 * @returns Delay in milliseconds
 */
export function calculateBackoffDelay(
  attempt: number,
  baseDelay: number = BASE_DELAY_MS,
): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  // Add jitter: +/- 25%
  const jitter = exponentialDelay * 0.25 * (2 * Math.random() - 1);
  return Math.round(exponentialDelay + jitter);
}

/**
 * Execute an async operation with automatic retry for transient errors.
 *
 * - Retries up to `maxRetries` times with exponential backoff
 * - Only retries if the error is classified as "transient"
 * - Persistent errors are thrown immediately
 * - Returns the result on success, or throws the last error on exhaustion
 *
 * @param operation - The async function to execute
 * @param classifyError - Function to classify caught errors
 * @param maxRetries - Maximum number of retries (default: MAX_RETRIES)
 * @param onRetry - Optional callback invoked before each retry (for telemetry)
 * @param delayFn - Optional delay function for testing (default: setTimeout-based)
 * @returns The result of the operation
 * @throws The classified error if all retries are exhausted or error is persistent
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  classifyError: (err: unknown) => ClassifiedError,
  maxRetries: number = MAX_RETRIES,
  onRetry?: (attempt: number, classified: ClassifiedError) => void,
  delayFn?: (ms: number) => Promise<void>,
): Promise<T> {
  const sleep = delayFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastClassified: ClassifiedError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastClassified = classifyError(err);

      // Persistent errors: throw immediately, no retry
      if (lastClassified.severity === "persistent") {
        throw new OnboardingError(lastClassified);
      }

      // Transient errors: retry if we have attempts left
      if (attempt < maxRetries) {
        if (onRetry) {
          onRetry(attempt, lastClassified);
        }
        const delay = calculateBackoffDelay(attempt);
        await sleep(delay);
      }
    }
  }

  // All retries exhausted
  throw new OnboardingError(lastClassified!);
}

// ---------------------------------------------------------------------------
// Custom error class
// ---------------------------------------------------------------------------

/**
 * Error class that carries the classified error details.
 * Allows UI code to access the classification without re-classifying.
 */
export class OnboardingError extends Error {
  readonly classified: ClassifiedError;

  constructor(classified: ClassifiedError) {
    super(classified.message);
    this.name = "OnboardingError";
    this.classified = classified;
  }
}

// ---------------------------------------------------------------------------
// Error telemetry
// ---------------------------------------------------------------------------

/**
 * Create an anonymized error telemetry event.
 *
 * BR-4: No PII in error logs. Only provider, error type, severity, and timestamp.
 * Optional fields are omitted (not set to false) per retro learning.
 *
 * @param classified - The classified error
 * @param options - Optional fields (retry_count, recovered, user_dismissed)
 * @returns Anonymized telemetry event
 */
export function createErrorTelemetryEvent(
  classified: ClassifiedError,
  options?: {
    retry_count?: number;
    recovered?: boolean;
    user_dismissed?: boolean;
  },
): ErrorTelemetryEvent {
  const event: ErrorTelemetryEvent = {
    provider: classified.provider,
    error_type: classified.code,
    severity: classified.severity,
    timestamp: new Date().toISOString(),
  };

  // Only set optional fields when explicitly provided (not undefined)
  // This preserves the distinction between "not applicable" and "zero/false"
  if (options?.retry_count !== undefined) {
    event.retry_count = options.retry_count;
  }
  if (options?.recovered !== undefined) {
    event.recovered = options.recovered;
  }
  if (options?.user_dismissed !== undefined) {
    event.user_dismissed = options.user_dismissed;
  }

  return event;
}

// ---------------------------------------------------------------------------
// Jargon check utility
// ---------------------------------------------------------------------------

/**
 * Check if a string contains technical jargon that should not be shown to users.
 *
 * @param text - Text to check
 * @returns Array of jargon terms found (empty if clean)
 */
export function findJargon(text: string): string[] {
  const lower = text.toLowerCase();
  return JARGON_TERMS.filter((term) => lower.includes(term));
}

// ---------------------------------------------------------------------------
// Popup blocker detection
// ---------------------------------------------------------------------------

/**
 * Attempt to open a URL in a popup window and detect if it was blocked.
 *
 * @param url - The URL to open
 * @returns Object with `blocked: true` if popup was blocked, `window` if opened
 */
export function openOAuthPopup(url: string): { blocked: boolean; popup: Window | null } {
  try {
    const popup = window.open(url, "_blank", "width=600,height=700");
    if (!popup || popup.closed || typeof popup.closed === "undefined") {
      return { blocked: true, popup: null };
    }
    return { blocked: false, popup };
  } catch {
    return { blocked: true, popup: null };
  }
}
