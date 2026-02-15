/**
 * Unit tests for ICS feed refresh and staleness detection.
 *
 * TM-d17.3: Tests cover:
 * - Change detection: ETag, Last-Modified, content hash, per-event diff
 * - Staleness calculation: stale at 2x interval, dead at 24h
 * - Error classification: 404, 401, timeout, malformed
 * - Refresh configuration: intervals, rate limiting
 * - Delta computation: new, modified, deleted events
 */

import { describe, it, expect } from "vitest";
import {
  computeContentHash,
  detectFeedChanges,
  classifyFeedError,
  computeStaleness,
  isRateLimited,
  buildConditionalHeaders,
  diffFeedEvents,
  DEFAULT_REFRESH_INTERVAL_MS,
  STALE_MULTIPLIER,
  DEAD_THRESHOLD_MS,
  MIN_REFRESH_INTERVAL_MS,
  VALID_REFRESH_INTERVALS,
  type FeedRefreshConfig,
  type FeedRefreshState,
  type FeedChangeResult,
  type FeedErrorClassification,
  type FeedStaleness,
  type FeedEventDiff,
} from "./ics-feed-refresh";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_ICS_A = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:event-001@example.com
DTSTART:20260301T090000Z
DTEND:20260301T100000Z
SUMMARY:Morning Standup
SEQUENCE:1
END:VEVENT
BEGIN:VEVENT
UID:event-002@example.com
DTSTART:20260302T140000Z
DTEND:20260302T150000Z
SUMMARY:Design Review
SEQUENCE:0
END:VEVENT
END:VCALENDAR`;

const SAMPLE_ICS_B = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:event-001@example.com
DTSTART:20260301T090000Z
DTEND:20260301T100000Z
SUMMARY:Morning Standup (Updated)
SEQUENCE:2
END:VEVENT
BEGIN:VEVENT
UID:event-003@example.com
DTSTART:20260303T100000Z
DTEND:20260303T110000Z
SUMMARY:New Meeting
SEQUENCE:0
END:VEVENT
END:VCALENDAR`;

// ---------------------------------------------------------------------------
// Content hash tests
// ---------------------------------------------------------------------------

describe("computeContentHash", () => {
  it("returns consistent hash for same content", () => {
    const hash1 = computeContentHash("hello world");
    const hash2 = computeContentHash("hello world");
    expect(hash1).toBe(hash2);
  });

  it("returns different hash for different content", () => {
    const hash1 = computeContentHash("hello world");
    const hash2 = computeContentHash("hello world!");
    expect(hash1).not.toBe(hash2);
  });

  it("returns a non-empty string", () => {
    const hash = computeContentHash(SAMPLE_ICS_A);
    expect(hash).toBeTruthy();
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  it("handles empty string", () => {
    const hash = computeContentHash("");
    expect(hash).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Conditional headers tests
// ---------------------------------------------------------------------------

describe("buildConditionalHeaders", () => {
  it("includes If-None-Match when etag is present", () => {
    const headers = buildConditionalHeaders({
      etag: '"abc123"',
    });
    expect(headers["If-None-Match"]).toBe('"abc123"');
    expect(headers["If-Modified-Since"]).toBeUndefined();
  });

  it("includes If-Modified-Since when lastModified is present", () => {
    const headers = buildConditionalHeaders({
      lastModified: "Wed, 01 Jan 2026 00:00:00 GMT",
    });
    expect(headers["If-Modified-Since"]).toBe("Wed, 01 Jan 2026 00:00:00 GMT");
    expect(headers["If-None-Match"]).toBeUndefined();
  });

  it("includes both headers when both are present", () => {
    const headers = buildConditionalHeaders({
      etag: '"abc123"',
      lastModified: "Wed, 01 Jan 2026 00:00:00 GMT",
    });
    expect(headers["If-None-Match"]).toBe('"abc123"');
    expect(headers["If-Modified-Since"]).toBe("Wed, 01 Jan 2026 00:00:00 GMT");
  });

  it("returns only Accept header when no cache data", () => {
    const headers = buildConditionalHeaders({});
    expect(Object.keys(headers)).toHaveLength(1);
    expect(headers["Accept"]).toBe("text/calendar, text/plain");
    expect(headers["If-None-Match"]).toBeUndefined();
    expect(headers["If-Modified-Since"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Feed change detection tests
// ---------------------------------------------------------------------------

describe("detectFeedChanges", () => {
  it("detects no change when status is 304 (Not Modified)", () => {
    const result = detectFeedChanges({
      httpStatus: 304,
      responseBody: null,
      previousContentHash: "abc123",
      etag: '"abc123"',
    });
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("not_modified");
  });

  it("detects no change when content hash matches", () => {
    const hash = computeContentHash(SAMPLE_ICS_A);
    const result = detectFeedChanges({
      httpStatus: 200,
      responseBody: SAMPLE_ICS_A,
      previousContentHash: hash,
    });
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("hash_match");
  });

  it("detects change when content hash differs", () => {
    const result = detectFeedChanges({
      httpStatus: 200,
      responseBody: SAMPLE_ICS_B,
      previousContentHash: computeContentHash(SAMPLE_ICS_A),
    });
    expect(result.changed).toBe(true);
    expect(result.reason).toBe("hash_changed");
    expect(result.newContentHash).toBeTruthy();
  });

  it("detects change when no previous hash exists (first fetch)", () => {
    const result = detectFeedChanges({
      httpStatus: 200,
      responseBody: SAMPLE_ICS_A,
      previousContentHash: undefined,
    });
    expect(result.changed).toBe(true);
    expect(result.reason).toBe("first_fetch");
    expect(result.newContentHash).toBeTruthy();
  });

  it("captures new etag from response", () => {
    const result = detectFeedChanges({
      httpStatus: 200,
      responseBody: SAMPLE_ICS_A,
      previousContentHash: undefined,
      etag: '"new-etag"',
    });
    expect(result.newEtag).toBe('"new-etag"');
  });

  it("captures new lastModified from response", () => {
    const result = detectFeedChanges({
      httpStatus: 200,
      responseBody: SAMPLE_ICS_A,
      previousContentHash: undefined,
      lastModified: "Thu, 01 Jan 2026 12:00:00 GMT",
    });
    expect(result.newLastModified).toBe("Thu, 01 Jan 2026 12:00:00 GMT");
  });
});

// ---------------------------------------------------------------------------
// Per-event diff tests
// ---------------------------------------------------------------------------

describe("diffFeedEvents", () => {
  it("detects new events", () => {
    const previousUIDs = new Map<string, number>([
      ["event-001@example.com", 1],
    ]);
    const currentUIDs = new Map<string, number>([
      ["event-001@example.com", 1],
      ["event-002@example.com", 0],
    ]);

    const diff = diffFeedEvents(previousUIDs, currentUIDs);
    expect(diff.added).toEqual(["event-002@example.com"]);
    expect(diff.modified).toEqual([]);
    expect(diff.deleted).toEqual([]);
  });

  it("detects deleted events", () => {
    const previousUIDs = new Map<string, number>([
      ["event-001@example.com", 1],
      ["event-002@example.com", 0],
    ]);
    const currentUIDs = new Map<string, number>([
      ["event-001@example.com", 1],
    ]);

    const diff = diffFeedEvents(previousUIDs, currentUIDs);
    expect(diff.added).toEqual([]);
    expect(diff.modified).toEqual([]);
    expect(diff.deleted).toEqual(["event-002@example.com"]);
  });

  it("detects modified events (SEQUENCE increased)", () => {
    const previousUIDs = new Map<string, number>([
      ["event-001@example.com", 1],
    ]);
    const currentUIDs = new Map<string, number>([
      ["event-001@example.com", 2],
    ]);

    const diff = diffFeedEvents(previousUIDs, currentUIDs);
    expect(diff.added).toEqual([]);
    expect(diff.modified).toEqual(["event-001@example.com"]);
    expect(diff.deleted).toEqual([]);
  });

  it("detects combined add/modify/delete", () => {
    const previousUIDs = new Map<string, number>([
      ["event-001@example.com", 1],
      ["event-002@example.com", 0],
    ]);
    const currentUIDs = new Map<string, number>([
      ["event-001@example.com", 2],
      ["event-003@example.com", 0],
    ]);

    const diff = diffFeedEvents(previousUIDs, currentUIDs);
    expect(diff.added).toEqual(["event-003@example.com"]);
    expect(diff.modified).toEqual(["event-001@example.com"]);
    expect(diff.deleted).toEqual(["event-002@example.com"]);
  });

  it("returns empty diff when nothing changed", () => {
    const uids = new Map<string, number>([
      ["event-001@example.com", 1],
    ]);

    const diff = diffFeedEvents(uids, new Map(uids));
    expect(diff.added).toEqual([]);
    expect(diff.modified).toEqual([]);
    expect(diff.deleted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Error classification tests
// ---------------------------------------------------------------------------

describe("classifyFeedError", () => {
  it("classifies 404 as dead feed", () => {
    const result = classifyFeedError(404);
    expect(result.category).toBe("dead");
    expect(result.retryable).toBe(false);
    expect(result.userActionRequired).toBe(true);
  });

  it("classifies 410 (Gone) as dead feed", () => {
    const result = classifyFeedError(410);
    expect(result.category).toBe("dead");
    expect(result.retryable).toBe(false);
    expect(result.userActionRequired).toBe(true);
  });

  it("classifies 401 as auth_required", () => {
    const result = classifyFeedError(401);
    expect(result.category).toBe("auth_required");
    expect(result.retryable).toBe(false);
    expect(result.userActionRequired).toBe(true);
  });

  it("classifies 403 as auth_required", () => {
    const result = classifyFeedError(403);
    expect(result.category).toBe("auth_required");
    expect(result.retryable).toBe(false);
    expect(result.userActionRequired).toBe(true);
  });

  it("classifies 500 as server_error (retryable)", () => {
    const result = classifyFeedError(500);
    expect(result.category).toBe("server_error");
    expect(result.retryable).toBe(true);
    expect(result.userActionRequired).toBe(false);
  });

  it("classifies 502 as server_error (retryable)", () => {
    const result = classifyFeedError(502);
    expect(result.category).toBe("server_error");
    expect(result.retryable).toBe(true);
  });

  it("classifies 503 as server_error (retryable)", () => {
    const result = classifyFeedError(503);
    expect(result.category).toBe("server_error");
    expect(result.retryable).toBe(true);
  });

  it("classifies 429 as rate_limited (retryable)", () => {
    const result = classifyFeedError(429);
    expect(result.category).toBe("rate_limited");
    expect(result.retryable).toBe(true);
    expect(result.userActionRequired).toBe(false);
  });

  it("classifies timeout (0) as timeout (retryable)", () => {
    const result = classifyFeedError(0);
    expect(result.category).toBe("timeout");
    expect(result.retryable).toBe(true);
  });

  it("classifies unknown 4xx as unknown", () => {
    const result = classifyFeedError(418);
    expect(result.category).toBe("unknown");
    expect(result.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Staleness calculation tests
// ---------------------------------------------------------------------------

describe("computeStaleness", () => {
  it("returns fresh when last refresh is recent", () => {
    const now = Date.now();
    const state: FeedRefreshState = {
      lastSuccessfulRefreshAt: new Date(now - 5 * 60 * 1000).toISOString(), // 5 min ago
      refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS, // 15 min
      consecutiveFailures: 0,
    };
    const result = computeStaleness(state, now);
    expect(result.status).toBe("fresh");
    expect(result.isDead).toBe(false);
  });

  it("returns stale when last refresh > 2x interval", () => {
    const now = Date.now();
    const state: FeedRefreshState = {
      lastSuccessfulRefreshAt: new Date(now - 35 * 60 * 1000).toISOString(), // 35 min ago
      refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS, // 15 min, 2x = 30 min
      consecutiveFailures: 0,
    };
    const result = computeStaleness(state, now);
    expect(result.status).toBe("stale");
    expect(result.isDead).toBe(false);
  });

  it("returns dead when last refresh > 24 hours", () => {
    const now = Date.now();
    const state: FeedRefreshState = {
      lastSuccessfulRefreshAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(), // 25 hours ago
      refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      consecutiveFailures: 0,
    };
    const result = computeStaleness(state, now);
    expect(result.status).toBe("dead");
    expect(result.isDead).toBe(true);
  });

  it("stale at exactly 2x interval", () => {
    const now = Date.now();
    const twoX = DEFAULT_REFRESH_INTERVAL_MS * STALE_MULTIPLIER;
    const state: FeedRefreshState = {
      lastSuccessfulRefreshAt: new Date(now - twoX - 1).toISOString(),
      refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      consecutiveFailures: 0,
    };
    const result = computeStaleness(state, now);
    expect(result.status).toBe("stale");
  });

  it("dead at exactly 24 hours", () => {
    const now = Date.now();
    const state: FeedRefreshState = {
      lastSuccessfulRefreshAt: new Date(now - DEAD_THRESHOLD_MS - 1).toISOString(),
      refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      consecutiveFailures: 0,
    };
    const result = computeStaleness(state, now);
    expect(result.status).toBe("dead");
    expect(result.isDead).toBe(true);
  });

  it("handles never-refreshed feed (null timestamp)", () => {
    const now = Date.now();
    const state: FeedRefreshState = {
      lastSuccessfulRefreshAt: null,
      refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      consecutiveFailures: 0,
    };
    const result = computeStaleness(state, now);
    expect(result.status).toBe("dead");
    expect(result.isDead).toBe(true);
  });

  it("reports milliseconds since last refresh", () => {
    const now = Date.now();
    const ago = 10 * 60 * 1000; // 10 min
    const state: FeedRefreshState = {
      lastSuccessfulRefreshAt: new Date(now - ago).toISOString(),
      refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      consecutiveFailures: 0,
    };
    const result = computeStaleness(state, now);
    expect(result.msSinceLastRefresh).toBeGreaterThanOrEqual(ago - 1);
    expect(result.msSinceLastRefresh).toBeLessThanOrEqual(ago + 100);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting tests
// ---------------------------------------------------------------------------

describe("isRateLimited", () => {
  it("returns false when lastFetchAt is null (never fetched)", () => {
    expect(isRateLimited(null, Date.now())).toBe(false);
  });

  it("returns true when last fetch was less than 5 minutes ago", () => {
    const now = Date.now();
    const twoMinAgo = new Date(now - 2 * 60 * 1000).toISOString();
    expect(isRateLimited(twoMinAgo, now)).toBe(true);
  });

  it("returns false when last fetch was more than 5 minutes ago", () => {
    const now = Date.now();
    const sixMinAgo = new Date(now - 6 * 60 * 1000).toISOString();
    expect(isRateLimited(sixMinAgo, now)).toBe(false);
  });

  it("returns false at exactly 5 minutes", () => {
    const now = Date.now();
    const fiveMinAgo = new Date(now - MIN_REFRESH_INTERVAL_MS).toISOString();
    expect(isRateLimited(fiveMinAgo, now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Refresh configuration constants tests
// ---------------------------------------------------------------------------

describe("Refresh configuration constants", () => {
  it("DEFAULT_REFRESH_INTERVAL_MS is 15 minutes", () => {
    expect(DEFAULT_REFRESH_INTERVAL_MS).toBe(15 * 60 * 1000);
  });

  it("STALE_MULTIPLIER is 2", () => {
    expect(STALE_MULTIPLIER).toBe(2);
  });

  it("DEAD_THRESHOLD_MS is 24 hours", () => {
    expect(DEAD_THRESHOLD_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("MIN_REFRESH_INTERVAL_MS is 5 minutes (rate limit)", () => {
    expect(MIN_REFRESH_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it("VALID_REFRESH_INTERVALS includes all required options", () => {
    expect(VALID_REFRESH_INTERVALS).toContain(5 * 60 * 1000);  // 5 min
    expect(VALID_REFRESH_INTERVALS).toContain(15 * 60 * 1000); // 15 min
    expect(VALID_REFRESH_INTERVALS).toContain(30 * 60 * 1000); // 30 min
    expect(VALID_REFRESH_INTERVALS).toContain(60 * 60 * 1000); // 1 hour
    expect(VALID_REFRESH_INTERVALS).toContain(0);               // manual only
  });
});
