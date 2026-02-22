/**
 * Unit tests for authority marker computation and conflict detection.
 *
 * Tests the pure functions that power the authority model:
 * - buildAuthorityMarkersForInsert: marks fields as provider-owned on INSERT
 * - resolveAuthorityMarkers: backward-compat resolution for legacy events
 * - detectAuthorityConflicts: field-level conflict detection matrix
 * - updateAuthorityMarkers: marker update after a provider write
 *
 * These are pure functions with no database or DO dependency.
 */

import { describe, it, expect } from "vitest";
import {
  buildAuthorityMarkersForInsert,
  resolveAuthorityMarkers,
  detectAuthorityConflicts,
  updateAuthorityMarkers,
  AUTHORITY_TRACKED_FIELDS,
} from "./index";
import type { AuthorityMarkers, FieldConflict } from "./index";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ACCOUNT_A = "acc_01AAAA";
const ACCOUNT_B = "acc_01BBBB";
const AUTHORITY_A = `provider:${ACCOUNT_A}`;
const AUTHORITY_B = `provider:${ACCOUNT_B}`;
const AUTHORITY_TMINUS = "tminus";

/**
 * Helper: create a full field-values record for a typical event.
 */
function makeFieldValues(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    title: "Team Standup",
    description: "Daily meeting",
    location: "Room A",
    start_ts: "2026-02-15T09:00:00Z",
    end_ts: "2026-02-15T09:30:00Z",
    timezone: "America/New_York",
    status: "confirmed",
    visibility: "default",
    transparency: "opaque",
    recurrence_rule: null,
    ...overrides,
  };
}

/**
 * Helper: create authority markers where all non-null fields are owned
 * by a single authority.
 */
function makeAllOwnedBy(
  authority: string,
  fieldValues: Record<string, unknown>,
): AuthorityMarkers {
  const markers: AuthorityMarkers = {};
  for (const field of AUTHORITY_TRACKED_FIELDS) {
    if (fieldValues[field] !== null && fieldValues[field] !== undefined) {
      markers[field] = authority;
    }
  }
  return markers;
}

// ---------------------------------------------------------------------------
// buildAuthorityMarkersForInsert
// ---------------------------------------------------------------------------

describe("buildAuthorityMarkersForInsert", () => {
  it("marks all non-null fields as owned by the provider account", () => {
    const fields = makeFieldValues();
    const markers = buildAuthorityMarkersForInsert(ACCOUNT_A, fields);

    expect(markers.title).toBe(AUTHORITY_A);
    expect(markers.description).toBe(AUTHORITY_A);
    expect(markers.location).toBe(AUTHORITY_A);
    expect(markers.start_ts).toBe(AUTHORITY_A);
    expect(markers.end_ts).toBe(AUTHORITY_A);
    expect(markers.timezone).toBe(AUTHORITY_A);
    expect(markers.status).toBe(AUTHORITY_A);
    expect(markers.visibility).toBe(AUTHORITY_A);
    expect(markers.transparency).toBe(AUTHORITY_A);
  });

  it("does not include null fields in markers", () => {
    const fields = makeFieldValues({ recurrence_rule: null, timezone: null });
    const markers = buildAuthorityMarkersForInsert(ACCOUNT_A, fields);

    expect(markers.recurrence_rule).toBeUndefined();
    expect(markers.timezone).toBeUndefined();
  });

  it("does not include undefined fields in markers", () => {
    const fields = makeFieldValues({ description: undefined });
    const markers = buildAuthorityMarkersForInsert(ACCOUNT_A, fields);

    expect(markers.description).toBeUndefined();
  });

  it("produces empty markers when all fields are null", () => {
    const fields: Record<string, unknown> = {};
    for (const f of AUTHORITY_TRACKED_FIELDS) {
      fields[f] = null;
    }
    const markers = buildAuthorityMarkersForInsert(ACCOUNT_A, fields);

    expect(Object.keys(markers)).toHaveLength(0);
  });

  it("only tracks authority-tracked fields, ignoring extras", () => {
    const fields = {
      ...makeFieldValues(),
      some_extra_field: "should be ignored",
    };
    const markers = buildAuthorityMarkersForInsert(ACCOUNT_A, fields);

    expect(markers).not.toHaveProperty("some_extra_field");
    // Exactly the tracked non-null fields
    const trackedNonNull = AUTHORITY_TRACKED_FIELDS.filter(
      (f) => fields[f] !== null && fields[f] !== undefined,
    );
    expect(Object.keys(markers)).toHaveLength(trackedNonNull.length);
  });
});

// ---------------------------------------------------------------------------
// resolveAuthorityMarkers
// ---------------------------------------------------------------------------

describe("resolveAuthorityMarkers", () => {
  it("returns parsed markers when they exist and are populated", () => {
    const existing: AuthorityMarkers = {
      title: AUTHORITY_A,
      description: AUTHORITY_TMINUS,
    };
    const result = resolveAuthorityMarkers(
      JSON.stringify(existing),
      ACCOUNT_A,
      makeFieldValues(),
    );

    expect(result).toEqual(existing);
  });

  it("treats empty JSON {} as backward-compat: fills all non-null fields as provider-owned", () => {
    const fields = makeFieldValues();
    const result = resolveAuthorityMarkers("{}", ACCOUNT_A, fields);

    // All non-null fields should be marked provider-owned
    expect(result.title).toBe(AUTHORITY_A);
    expect(result.description).toBe(AUTHORITY_A);
    expect(result.start_ts).toBe(AUTHORITY_A);
  });

  it("treats null raw as backward-compat", () => {
    const fields = makeFieldValues();
    const result = resolveAuthorityMarkers(null, ACCOUNT_A, fields);

    expect(result.title).toBe(AUTHORITY_A);
  });

  it("treats undefined raw as backward-compat", () => {
    const fields = makeFieldValues();
    const result = resolveAuthorityMarkers(undefined, ACCOUNT_A, fields);

    expect(result.title).toBe(AUTHORITY_A);
  });

  it("backward-compat skips null fields in the current row", () => {
    const fields = makeFieldValues({ recurrence_rule: null, timezone: null });
    const result = resolveAuthorityMarkers("{}", ACCOUNT_A, fields);

    expect(result.recurrence_rule).toBeUndefined();
    expect(result.timezone).toBeUndefined();
    expect(result.title).toBe(AUTHORITY_A);
  });
});

// ---------------------------------------------------------------------------
// detectAuthorityConflicts
// ---------------------------------------------------------------------------

describe("detectAuthorityConflicts", () => {
  it("returns no conflicts when provider modifies own fields", () => {
    const markers = makeAllOwnedBy(AUTHORITY_A, makeFieldValues());
    const currentRow = makeFieldValues();
    const incoming = makeFieldValues({ title: "Updated Title" });

    const conflicts = detectAuthorityConflicts(ACCOUNT_A, markers, currentRow, incoming);

    expect(conflicts).toHaveLength(0);
  });

  it("detects conflict when provider modifies tminus-owned field", () => {
    const markers = makeAllOwnedBy(AUTHORITY_A, makeFieldValues());
    markers.title = AUTHORITY_TMINUS; // tminus owns title

    const currentRow = makeFieldValues();
    const incoming = makeFieldValues({ title: "Provider Override" });

    const conflicts = detectAuthorityConflicts(ACCOUNT_A, markers, currentRow, incoming);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe("title");
    expect(conflicts[0].current_authority).toBe(AUTHORITY_TMINUS);
    expect(conflicts[0].incoming_authority).toBe(AUTHORITY_A);
    expect(conflicts[0].old_value).toBe("Team Standup");
    expect(conflicts[0].new_value).toBe("Provider Override");
  });

  it("detects conflict when provider modifies field owned by different provider", () => {
    const markers = makeAllOwnedBy(AUTHORITY_A, makeFieldValues());
    const currentRow = makeFieldValues();
    const incoming = makeFieldValues({ title: "Provider B Override" });

    // ACCOUNT_B is modifying fields owned by ACCOUNT_A
    const conflicts = detectAuthorityConflicts(ACCOUNT_B, markers, currentRow, incoming);

    // title, description, location, start_ts, end_ts, timezone, status, visibility, transparency
    // are all changing from AUTHORITY_A ownership (since all same as currentRow but incoming has
    // different title)
    expect(conflicts).toHaveLength(1); // only title actually changed
    expect(conflicts[0].field).toBe("title");
    expect(conflicts[0].current_authority).toBe(AUTHORITY_A);
    expect(conflicts[0].incoming_authority).toBe(AUTHORITY_B);
  });

  it("skips fields that are not changing (same value)", () => {
    const markers = makeAllOwnedBy(AUTHORITY_A, makeFieldValues());
    const currentRow = makeFieldValues();
    // Incoming has identical values -- no changes
    const incoming = makeFieldValues();

    const conflicts = detectAuthorityConflicts(ACCOUNT_B, markers, currentRow, incoming);

    expect(conflicts).toHaveLength(0);
  });

  it("skips fields with no authority recorded (backward compat)", () => {
    // Empty markers = no authority recorded
    const markers: AuthorityMarkers = {};
    const currentRow = makeFieldValues();
    const incoming = makeFieldValues({ title: "Changed" });

    const conflicts = detectAuthorityConflicts(ACCOUNT_A, markers, currentRow, incoming);

    expect(conflicts).toHaveLength(0);
  });

  it("handles multiple fields in conflict simultaneously", () => {
    const markers: AuthorityMarkers = {
      title: AUTHORITY_TMINUS,
      description: AUTHORITY_TMINUS,
      location: AUTHORITY_A,
    };
    const currentRow = makeFieldValues();
    const incoming = makeFieldValues({
      title: "Changed Title",
      description: "Changed Description",
      location: "Changed Location",
    });

    const conflicts = detectAuthorityConflicts(ACCOUNT_B, markers, currentRow, incoming);

    // title (tminus) and description (tminus) and location (A) all conflict for B
    expect(conflicts).toHaveLength(3);
    const fields = conflicts.map((c) => c.field).sort();
    expect(fields).toEqual(["description", "location", "title"]);
  });

  it("skips undefined incoming fields (not being provided)", () => {
    const markers = makeAllOwnedBy(AUTHORITY_TMINUS, makeFieldValues());
    const currentRow = makeFieldValues();
    // Only providing title, not all fields
    const incoming: Record<string, unknown> = { title: "Changed" };

    const conflicts = detectAuthorityConflicts(ACCOUNT_A, markers, currentRow, incoming);

    // Only title should show as conflict, other fields are undefined (not provided)
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe("title");
  });

  it("does not produce false positive on numeric/string type mismatch", () => {
    // all_day is stored as 0/1 in SQLite but might come as number
    const markers: AuthorityMarkers = { status: AUTHORITY_TMINUS };
    const currentRow = makeFieldValues({ status: "confirmed" });
    // Same value, should not conflict
    const incoming = makeFieldValues({ status: "confirmed" });

    const conflicts = detectAuthorityConflicts(ACCOUNT_A, markers, currentRow, incoming);
    expect(conflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// updateAuthorityMarkers
// ---------------------------------------------------------------------------

describe("updateAuthorityMarkers", () => {
  it("updates authority for provided non-null fields", () => {
    const current: AuthorityMarkers = {
      title: AUTHORITY_A,
      description: AUTHORITY_A,
      location: AUTHORITY_A,
    };
    const incoming = { title: "New Title", description: "New Desc" };

    const updated = updateAuthorityMarkers(current, ACCOUNT_B, incoming);

    expect(updated.title).toBe(AUTHORITY_B);
    expect(updated.description).toBe(AUTHORITY_B);
    // location was not in incoming, retains A
    expect(updated.location).toBe(AUTHORITY_A);
  });

  it("retains existing authority for fields not in incoming", () => {
    const current: AuthorityMarkers = {
      title: AUTHORITY_TMINUS,
      start_ts: AUTHORITY_A,
    };
    const incoming = { start_ts: "2026-03-01T10:00:00Z" };

    const updated = updateAuthorityMarkers(current, ACCOUNT_B, incoming);

    expect(updated.title).toBe(AUTHORITY_TMINUS);
    expect(updated.start_ts).toBe(AUTHORITY_B);
  });

  it("does not add authority for null values", () => {
    const current: AuthorityMarkers = { title: AUTHORITY_A };
    const incoming = { title: null, description: "Has Value" };

    const updated = updateAuthorityMarkers(current, ACCOUNT_B, incoming);

    // title was null, should not be updated to B
    expect(updated.title).toBe(AUTHORITY_A);
    expect(updated.description).toBe(AUTHORITY_B);
  });

  it("does not add authority for undefined values", () => {
    const current: AuthorityMarkers = { title: AUTHORITY_A };
    const incoming = { title: undefined };

    const updated = updateAuthorityMarkers(current, ACCOUNT_B, incoming);

    expect(updated.title).toBe(AUTHORITY_A);
  });

  it("does not mutate the input markers", () => {
    const current: AuthorityMarkers = { title: AUTHORITY_A };
    const original = { ...current };
    const incoming = { title: "Changed" };

    updateAuthorityMarkers(current, ACCOUNT_B, incoming);

    expect(current).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// AUTHORITY_TRACKED_FIELDS constant
// ---------------------------------------------------------------------------

describe("AUTHORITY_TRACKED_FIELDS", () => {
  it("includes all expected mutable canonical_event fields", () => {
    const expected = [
      "title",
      "description",
      "location",
      "start_ts",
      "end_ts",
      "timezone",
      "status",
      "visibility",
      "transparency",
      "recurrence_rule",
    ];
    expect([...AUTHORITY_TRACKED_FIELDS]).toEqual(expected);
  });

  it("does not include immutable fields like canonical_event_id or origin_event_id", () => {
    expect(AUTHORITY_TRACKED_FIELDS).not.toContain("canonical_event_id");
    expect(AUTHORITY_TRACKED_FIELDS).not.toContain("origin_event_id");
    expect(AUTHORITY_TRACKED_FIELDS).not.toContain("origin_account_id");
    expect(AUTHORITY_TRACKED_FIELDS).not.toContain("source");
    expect(AUTHORITY_TRACKED_FIELDS).not.toContain("version");
    expect(AUTHORITY_TRACKED_FIELDS).not.toContain("created_at");
    expect(AUTHORITY_TRACKED_FIELDS).not.toContain("updated_at");
  });
});
