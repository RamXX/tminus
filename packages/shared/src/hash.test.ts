/**
 * @tminus/shared -- Unit tests for stable hashing and idempotency keys.
 *
 * Tests computeProjectionHash() determinism, sensitivity to relevant fields,
 * insensitivity to irrelevant fields, and computeIdempotencyKey() determinism.
 */
import { describe, it, expect } from "vitest";
import type { ProjectedEvent } from "./types";
import { computeProjectionHash, computeIdempotencyKey } from "./hash";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeProjection(overrides: Partial<ProjectedEvent> = {}): ProjectedEvent {
  return {
    summary: "Busy",
    start: { dateTime: "2025-06-15T09:00:00Z" },
    end: { dateTime: "2025-06-15T09:30:00Z" },
    transparency: "opaque",
    visibility: "private",
    extendedProperties: {
      private: {
        tminus: "true",
        managed: "true",
        canonical_event_id: "evt_01",
        origin_account_id: "acc_01",
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeProjectionHash -- determinism
// ---------------------------------------------------------------------------

describe("computeProjectionHash -- determinism (Invariant C)", () => {
  it("produces the same hash for identical inputs", async () => {
    const projection = makeProjection();
    const hash1 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", projection);
    const hash2 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", projection);
    expect(hash1).toBe(hash2);
  });

  it("produces a hex string", async () => {
    const hash = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", makeProjection());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a 64-character SHA-256 hex digest", async () => {
    const hash = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", makeProjection());
    expect(hash).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// computeProjectionHash -- sensitivity to relevant changes
// ---------------------------------------------------------------------------

describe("computeProjectionHash -- changes when relevant fields change", () => {
  it("changes when summary changes", async () => {
    const base = makeProjection();
    const changed = makeProjection({ summary: "Meeting with Bob" });
    const h1 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", base);
    const h2 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", changed);
    expect(h1).not.toBe(h2);
  });

  it("changes when start time changes", async () => {
    const base = makeProjection();
    const changed = makeProjection({ start: { dateTime: "2025-06-15T10:00:00Z" } });
    const h1 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", base);
    const h2 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", changed);
    expect(h1).not.toBe(h2);
  });

  it("changes when end time changes", async () => {
    const base = makeProjection();
    const changed = makeProjection({ end: { dateTime: "2025-06-15T11:00:00Z" } });
    const h1 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", base);
    const h2 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", changed);
    expect(h1).not.toBe(h2);
  });

  it("changes when transparency changes", async () => {
    const base = makeProjection();
    const changed = makeProjection({ transparency: "transparent" });
    const h1 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", base);
    const h2 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", changed);
    expect(h1).not.toBe(h2);
  });

  it("changes when visibility changes", async () => {
    const base = makeProjection();
    const changed = makeProjection({ visibility: "default" });
    const h1 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", base);
    const h2 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", changed);
    expect(h1).not.toBe(h2);
  });

  it("changes when detail_level changes", async () => {
    const projection = makeProjection();
    const h1 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", projection);
    const h2 = await computeProjectionHash("evt_01", "TITLE", "BUSY_OVERLAY", projection);
    expect(h1).not.toBe(h2);
  });

  it("changes when calendar_kind changes", async () => {
    const projection = makeProjection();
    const h1 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", projection);
    const h2 = await computeProjectionHash("evt_01", "BUSY", "TRUE_MIRROR", projection);
    expect(h1).not.toBe(h2);
  });

  it("changes when canonical_event_id changes", async () => {
    const projection = makeProjection();
    const h1 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", projection);
    const h2 = await computeProjectionHash("evt_02", "BUSY", "BUSY_OVERLAY", projection);
    expect(h1).not.toBe(h2);
  });

  it("changes when description is added", async () => {
    const base = makeProjection();
    const withDesc = makeProjection({ description: "Some description" });
    const h1 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", base);
    const h2 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", withDesc);
    expect(h1).not.toBe(h2);
  });

  it("changes when location is added", async () => {
    const base = makeProjection();
    const withLoc = makeProjection({ location: "Room 42" });
    const h1 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", base);
    const h2 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", withLoc);
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// computeProjectionHash -- insensitivity to irrelevant changes
// ---------------------------------------------------------------------------

describe("computeProjectionHash -- does NOT change for irrelevant changes", () => {
  it("does NOT change when extendedProperties origin_account_id differs", async () => {
    // extendedProperties are metadata for tracking, not projected content.
    // The hash is over the canonical_event_id param + detail_level + calendar_kind
    // + the *content* fields of the projection (summary, start, end, etc.).
    // extendedProperties are tracking metadata that don't affect whether
    // the mirror content needs updating.
    const p1 = makeProjection();
    const p2: ProjectedEvent = {
      ...p1,
      extendedProperties: {
        private: {
          ...p1.extendedProperties.private,
          origin_account_id: "acc_99",
        },
      },
    };
    const h1 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", p1);
    const h2 = await computeProjectionHash("evt_01", "BUSY", "BUSY_OVERLAY", p2);
    expect(h1).toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// computeIdempotencyKey -- determinism (Invariant D)
// ---------------------------------------------------------------------------

describe("computeIdempotencyKey -- determinism (Invariant D)", () => {
  it("produces the same key for identical inputs", async () => {
    const k1 = await computeIdempotencyKey("evt_01", "acc_02", "abc123hash");
    const k2 = await computeIdempotencyKey("evt_01", "acc_02", "abc123hash");
    expect(k1).toBe(k2);
  });

  it("produces a hex string", async () => {
    const key = await computeIdempotencyKey("evt_01", "acc_02", "abc123hash");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when canonical_event_id differs", async () => {
    const k1 = await computeIdempotencyKey("evt_01", "acc_02", "abc123hash");
    const k2 = await computeIdempotencyKey("evt_99", "acc_02", "abc123hash");
    expect(k1).not.toBe(k2);
  });

  it("changes when target_account_id differs", async () => {
    const k1 = await computeIdempotencyKey("evt_01", "acc_02", "abc123hash");
    const k2 = await computeIdempotencyKey("evt_01", "acc_99", "abc123hash");
    expect(k1).not.toBe(k2);
  });

  it("changes when projected_hash differs", async () => {
    const k1 = await computeIdempotencyKey("evt_01", "acc_02", "abc123hash");
    const k2 = await computeIdempotencyKey("evt_01", "acc_02", "xyz789hash");
    expect(k1).not.toBe(k2);
  });
});
