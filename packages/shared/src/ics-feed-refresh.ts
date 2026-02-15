/**
 * @tminus/shared -- ICS Feed Refresh & Staleness Detection.
 *
 * TM-d17.3: Provides the core logic for periodic ICS feed polling.
 * Unlike OAuth-synced accounts that receive push notifications, ICS feeds
 * must be polled. This module handles:
 *
 * - Change detection via ETag, Last-Modified, and content hashing
 * - Per-event diffing (UID + SEQUENCE comparison)
 * - Staleness computation (fresh/stale/dead)
 * - Error classification for feed fetch failures
 * - Rate limiting (max 1 request per feed per 5 minutes, BR-4)
 *
 * Design decisions:
 * - Pure functions, no side effects -- all state passed in, results returned
 * - Content hashing uses djb2 (fast, deterministic, no crypto dependency)
 * - Optional properties with key omission per learning from TM-lfy retro
 * - Staleness: stale at 2x configured interval, dead at 24 hours
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default refresh interval: 15 minutes. */
export const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/** Staleness multiplier: feed is stale when age > multiplier * interval. */
export const STALE_MULTIPLIER = 2;

/** Dead threshold: 24 hours without successful refresh. */
export const DEAD_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Minimum refresh interval (rate limit): 5 minutes per feed (BR-4). */
export const MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Valid refresh intervals in milliseconds.
 * 0 = manual only (no automatic refresh).
 * Per story: 5 min, 15 min, 30 min, 1 hour, manual only.
 */
export const VALID_REFRESH_INTERVALS: readonly number[] = [
  5 * 60 * 1000,   // 5 minutes
  15 * 60 * 1000,  // 15 minutes (default)
  30 * 60 * 1000,  // 30 minutes
  60 * 60 * 1000,  // 1 hour
  0,               // manual only
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** User-configurable refresh settings for a feed. */
export interface FeedRefreshConfig {
  /** Refresh interval in milliseconds. Omit to use default (15 min). */
  readonly refreshIntervalMs?: number;
}

/** Current state of a feed's refresh tracking. */
export interface FeedRefreshState {
  /** ISO timestamp of last successful refresh, or null if never refreshed. */
  readonly lastSuccessfulRefreshAt: string | null;
  /** Configured refresh interval in milliseconds. */
  readonly refreshIntervalMs: number;
  /** Number of consecutive fetch failures. */
  readonly consecutiveFailures: number;
  /** ETag from last successful response. */
  readonly etag?: string;
  /** Last-Modified header from last successful response. */
  readonly lastModified?: string;
  /** Content hash (djb2) from last successful response body. */
  readonly contentHash?: string;
  /** ISO timestamp of last fetch attempt (success or failure). */
  readonly lastFetchAt?: string;
  /** Map of event UID -> SEQUENCE number from last successful parse. */
  readonly eventSequences?: ReadonlyMap<string, number>;
}

/** Result of change detection for a feed fetch. */
export interface FeedChangeResult {
  /** Whether the feed content changed since last fetch. */
  readonly changed: boolean;
  /** Reason for the change/no-change determination. */
  readonly reason: "not_modified" | "hash_match" | "hash_changed" | "first_fetch";
  /** New content hash (present when changed or first_fetch). */
  readonly newContentHash?: string;
  /** New ETag from response headers. */
  readonly newEtag?: string;
  /** New Last-Modified from response headers. */
  readonly newLastModified?: string;
}

/** Classified feed fetch error. */
export interface FeedErrorClassification {
  /** Error category. */
  readonly category: "dead" | "auth_required" | "server_error" | "rate_limited" | "timeout" | "malformed" | "unknown";
  /** Whether the error is transient and should be retried. */
  readonly retryable: boolean;
  /** Whether the user needs to take action. */
  readonly userActionRequired: boolean;
}

/** Staleness assessment for a feed. */
export interface FeedStaleness {
  /** Current staleness status. */
  readonly status: "fresh" | "stale" | "dead";
  /** Whether the feed is considered dead (>24h without refresh). */
  readonly isDead: boolean;
  /** Milliseconds since last successful refresh (Infinity if never refreshed). */
  readonly msSinceLastRefresh: number;
}

/** Result of per-event diffing between two feed states. */
export interface FeedEventDiff {
  /** UIDs of newly added events. */
  readonly added: readonly string[];
  /** UIDs of events with increased SEQUENCE (modified). */
  readonly modified: readonly string[];
  /** UIDs of events no longer present (deleted). */
  readonly deleted: readonly string[];
}

// ---------------------------------------------------------------------------
// Content hashing (djb2 -- fast, deterministic, no crypto needed)
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic hash of ICS content for change detection.
 * Uses djb2 algorithm -- fast and sufficient for cache invalidation.
 *
 * @param content - Raw ICS text
 * @returns Hex string hash
 */
export function computeContentHash(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    // djb2: hash * 33 + char
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  // Convert to unsigned 32-bit hex
  return (hash >>> 0).toString(16);
}

// ---------------------------------------------------------------------------
// HTTP conditional request headers (BR-2)
// ---------------------------------------------------------------------------

/**
 * Build HTTP conditional request headers for bandwidth-efficient feed polling.
 * Per BR-2: use ETag/If-None-Match and Last-Modified/If-Modified-Since.
 *
 * @param cacheData - Previous ETag and/or Last-Modified values
 * @returns Headers object to include in the fetch request
 */
export function buildConditionalHeaders(cacheData: {
  etag?: string;
  lastModified?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept": "text/calendar, text/plain",
  };

  if (cacheData.etag) {
    headers["If-None-Match"] = cacheData.etag;
  }

  if (cacheData.lastModified) {
    headers["If-Modified-Since"] = cacheData.lastModified;
  }

  return headers;
}

// ---------------------------------------------------------------------------
// Feed change detection
// ---------------------------------------------------------------------------

/**
 * Determine whether an ICS feed has changed since the last fetch.
 *
 * Detection priority:
 * 1. HTTP 304 Not Modified -> no change (server confirmed via ETag/Last-Modified)
 * 2. Content hash comparison -> no change if hash matches
 * 3. Otherwise -> changed
 *
 * @param params - Fetch result parameters
 * @returns Change detection result
 */
export function detectFeedChanges(params: {
  httpStatus: number;
  responseBody: string | null;
  previousContentHash?: string;
  etag?: string;
  lastModified?: string;
}): FeedChangeResult {
  // HTTP 304 Not Modified -- server confirmed no change
  if (params.httpStatus === 304) {
    return {
      changed: false,
      reason: "not_modified",
      newEtag: params.etag,
      newLastModified: params.lastModified,
    };
  }

  // Compute content hash
  const body = params.responseBody ?? "";
  const newHash = computeContentHash(body);

  // First fetch (no previous hash)
  if (params.previousContentHash === undefined) {
    return {
      changed: true,
      reason: "first_fetch",
      newContentHash: newHash,
      newEtag: params.etag,
      newLastModified: params.lastModified,
    };
  }

  // Compare hashes
  if (newHash === params.previousContentHash) {
    return {
      changed: false,
      reason: "hash_match",
      newContentHash: newHash,
      newEtag: params.etag,
      newLastModified: params.lastModified,
    };
  }

  return {
    changed: true,
    reason: "hash_changed",
    newContentHash: newHash,
    newEtag: params.etag,
    newLastModified: params.lastModified,
  };
}

// ---------------------------------------------------------------------------
// Per-event diffing
// ---------------------------------------------------------------------------

/**
 * Diff two sets of event UIDs with SEQUENCE numbers to detect
 * additions, modifications, and deletions.
 *
 * Per RFC 5545, SEQUENCE is incremented when an event is modified.
 * If a UID is present in current but not previous -> added.
 * If a UID is present in both but SEQUENCE increased -> modified.
 * If a UID is present in previous but not current -> deleted.
 *
 * @param previousUIDs - Map of UID -> SEQUENCE from last parse
 * @param currentUIDs - Map of UID -> SEQUENCE from current parse
 * @returns Diff result
 */
export function diffFeedEvents(
  previousUIDs: ReadonlyMap<string, number>,
  currentUIDs: ReadonlyMap<string, number>,
): FeedEventDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  // Check current against previous
  for (const [uid, seq] of currentUIDs) {
    const prevSeq = previousUIDs.get(uid);
    if (prevSeq === undefined) {
      added.push(uid);
    } else if (seq > prevSeq) {
      modified.push(uid);
    }
  }

  // Check previous against current for deletions
  for (const uid of previousUIDs.keys()) {
    if (!currentUIDs.has(uid)) {
      deleted.push(uid);
    }
  }

  return { added, modified, deleted };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify an HTTP error (or timeout) from a feed fetch attempt.
 *
 * Categories:
 * - dead: 404/410 -- feed URL is broken, user action required
 * - auth_required: 401/403 -- feed needs authentication
 * - server_error: 5xx -- transient server issue, retry with backoff
 * - rate_limited: 429 -- too many requests, retry later
 * - timeout: 0 -- network timeout, retry with backoff
 * - unknown: anything else
 *
 * @param httpStatus - HTTP status code (0 for timeout/network error)
 * @returns Error classification
 */
export function classifyFeedError(httpStatus: number): FeedErrorClassification {
  if (httpStatus === 0) {
    return { category: "timeout", retryable: true, userActionRequired: false };
  }

  if (httpStatus === 404 || httpStatus === 410) {
    return { category: "dead", retryable: false, userActionRequired: true };
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return { category: "auth_required", retryable: false, userActionRequired: true };
  }

  if (httpStatus === 429) {
    return { category: "rate_limited", retryable: true, userActionRequired: false };
  }

  if (httpStatus >= 500 && httpStatus < 600) {
    return { category: "server_error", retryable: true, userActionRequired: false };
  }

  return { category: "unknown", retryable: false, userActionRequired: false };
}

// ---------------------------------------------------------------------------
// Staleness computation
// ---------------------------------------------------------------------------

/**
 * Compute the staleness status of a feed based on its refresh state.
 *
 * Per story requirements:
 * - Fresh: last refresh within configured interval
 * - Stale: last refresh > 2x configured interval
 * - Dead: last refresh > 24 hours (or never refreshed)
 *
 * @param state - Current feed refresh state
 * @param now - Current timestamp in milliseconds
 * @returns Staleness assessment
 */
export function computeStaleness(
  state: FeedRefreshState,
  now: number = Date.now(),
): FeedStaleness {
  if (state.lastSuccessfulRefreshAt === null) {
    return { status: "dead", isDead: true, msSinceLastRefresh: Infinity };
  }

  const lastRefreshMs = new Date(state.lastSuccessfulRefreshAt).getTime();
  const elapsed = now - lastRefreshMs;

  // Dead: > 24 hours
  if (elapsed > DEAD_THRESHOLD_MS) {
    return { status: "dead", isDead: true, msSinceLastRefresh: elapsed };
  }

  // Stale: > 2x interval
  if (elapsed > state.refreshIntervalMs * STALE_MULTIPLIER) {
    return { status: "stale", isDead: false, msSinceLastRefresh: elapsed };
  }

  return { status: "fresh", isDead: false, msSinceLastRefresh: elapsed };
}

// ---------------------------------------------------------------------------
// Rate limiting (BR-4)
// ---------------------------------------------------------------------------

/**
 * Check if a feed is rate-limited (max 1 request per 5 minutes, BR-4).
 *
 * @param lastFetchAt - ISO timestamp of last fetch attempt (null if never)
 * @param now - Current timestamp in milliseconds
 * @returns true if the feed should NOT be fetched yet
 */
export function isRateLimited(
  lastFetchAt: string | null,
  now: number = Date.now(),
): boolean {
  if (lastFetchAt === null) return false;
  const lastMs = new Date(lastFetchAt).getTime();
  return (now - lastMs) < MIN_REFRESH_INTERVAL_MS;
}
