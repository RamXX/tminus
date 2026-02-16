/**
 * Unit tests for discovery schemas (TM-9iu.3).
 *
 * Tests:
 * - Directory API response parsing
 * - User lifecycle state machine transitions
 * - OU filter logic (hierarchical matching)
 * - Email exclusion logic (case-insensitive)
 * - Discovery config validation
 * - User status determination from Directory API data
 */

import { describe, it, expect } from "vitest";
import {
  DirectoryUserSchema,
  DirectoryListResponseSchema,
  DiscoveryConfigSchema,
  DiscoveredUserStatusSchema,
  isValidTransition,
  getAllowedTransitions,
  parseDirectoryResponse,
  parseDiscoveryConfig,
  determineUserStatus,
  filterByOU,
  filterExcluded,
  DIRECTORY_API_RATE_LIMITS,
} from "./discovery-schemas";
import type { DirectoryUser } from "./discovery-schemas";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeDirectoryUser(overrides?: Partial<DirectoryUser>): DirectoryUser {
  return {
    id: "user-001",
    primaryEmail: "alice@acme.com",
    name: { fullName: "Alice Smith", givenName: "Alice", familyName: "Smith" },
    suspended: false,
    archived: false,
    orgUnitPath: "/Engineering",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Directory API response parsing
// ---------------------------------------------------------------------------

describe("DirectoryUserSchema", () => {
  it("parses a valid user from Directory API", () => {
    const result = DirectoryUserSchema.parse({
      id: "user-001",
      primaryEmail: "alice@acme.com",
      name: { fullName: "Alice Smith" },
      suspended: false,
      archived: false,
      orgUnitPath: "/Engineering",
    });

    expect(result.id).toBe("user-001");
    expect(result.primaryEmail).toBe("alice@acme.com");
    expect(result.name.fullName).toBe("Alice Smith");
    expect(result.suspended).toBe(false);
    expect(result.orgUnitPath).toBe("/Engineering");
  });

  it("defaults suspended and archived to false when missing", () => {
    const result = DirectoryUserSchema.parse({
      id: "user-002",
      primaryEmail: "bob@acme.com",
      name: { fullName: "Bob Jones" },
    });

    expect(result.suspended).toBe(false);
    expect(result.archived).toBe(false);
  });

  it("allows optional fields to be missing", () => {
    const result = DirectoryUserSchema.parse({
      id: "user-003",
      primaryEmail: "carol@acme.com",
      name: {},
    });

    expect(result.name.fullName).toBeUndefined();
    expect(result.name.givenName).toBeUndefined();
    expect(result.orgUnitPath).toBeUndefined();
  });

  it("rejects missing required fields", () => {
    expect(() =>
      DirectoryUserSchema.parse({ primaryEmail: "no-id@acme.com", name: {} }),
    ).toThrow();

    expect(() =>
      DirectoryUserSchema.parse({ id: "user-x", name: {} }),
    ).toThrow();
  });

  it("rejects invalid email format", () => {
    expect(() =>
      DirectoryUserSchema.parse({
        id: "user-x",
        primaryEmail: "not-an-email",
        name: {},
      }),
    ).toThrow();
  });
});

describe("DirectoryListResponseSchema", () => {
  it("parses a paginated response with users", () => {
    const result = DirectoryListResponseSchema.parse({
      users: [
        { id: "u1", primaryEmail: "a@acme.com", name: {} },
        { id: "u2", primaryEmail: "b@acme.com", name: {} },
      ],
      nextPageToken: "page2token",
    });

    expect(result.users).toHaveLength(2);
    expect(result.nextPageToken).toBe("page2token");
  });

  it("defaults to empty users array when missing", () => {
    const result = DirectoryListResponseSchema.parse({});
    expect(result.users).toEqual([]);
    expect(result.nextPageToken).toBeUndefined();
  });

  it("parses last page (no nextPageToken)", () => {
    const result = DirectoryListResponseSchema.parse({
      users: [{ id: "u1", primaryEmail: "a@acme.com", name: {} }],
    });

    expect(result.users).toHaveLength(1);
    expect(result.nextPageToken).toBeUndefined();
  });
});

describe("parseDirectoryResponse", () => {
  it("validates and returns a DirectoryListResponse", () => {
    const result = parseDirectoryResponse({
      users: [{ id: "u1", primaryEmail: "a@acme.com", name: { fullName: "A" } }],
    });

    expect(result.users).toHaveLength(1);
    expect(result.users[0].primaryEmail).toBe("a@acme.com");
  });

  it("throws on invalid data", () => {
    expect(() => parseDirectoryResponse("not an object")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// User lifecycle state machine
// ---------------------------------------------------------------------------

describe("DiscoveredUserStatusSchema", () => {
  it("accepts valid statuses", () => {
    expect(DiscoveredUserStatusSchema.parse("active")).toBe("active");
    expect(DiscoveredUserStatusSchema.parse("suspended")).toBe("suspended");
    expect(DiscoveredUserStatusSchema.parse("removed")).toBe("removed");
  });

  it("rejects invalid status", () => {
    expect(() => DiscoveredUserStatusSchema.parse("deleted")).toThrow();
    expect(() => DiscoveredUserStatusSchema.parse("")).toThrow();
  });
});

describe("isValidTransition", () => {
  // Active transitions
  it("active -> suspended is valid", () => {
    expect(isValidTransition("active", "suspended")).toBe(true);
  });

  it("active -> removed is valid", () => {
    expect(isValidTransition("active", "removed")).toBe(true);
  });

  it("active -> active is invalid (no self-transition)", () => {
    expect(isValidTransition("active", "active")).toBe(false);
  });

  // Suspended transitions
  it("suspended -> active is valid (reactivation)", () => {
    expect(isValidTransition("suspended", "active")).toBe(true);
  });

  it("suspended -> removed is valid", () => {
    expect(isValidTransition("suspended", "removed")).toBe(true);
  });

  it("suspended -> suspended is invalid", () => {
    expect(isValidTransition("suspended", "suspended")).toBe(false);
  });

  // Removed transitions (terminal)
  it("removed -> active is invalid (terminal state)", () => {
    expect(isValidTransition("removed", "active")).toBe(false);
  });

  it("removed -> suspended is invalid (terminal state)", () => {
    expect(isValidTransition("removed", "suspended")).toBe(false);
  });

  it("removed -> removed is invalid (terminal state)", () => {
    expect(isValidTransition("removed", "removed")).toBe(false);
  });
});

describe("getAllowedTransitions", () => {
  it("returns [suspended, removed] for active", () => {
    expect(getAllowedTransitions("active")).toEqual(["suspended", "removed"]);
  });

  it("returns [active, removed] for suspended", () => {
    expect(getAllowedTransitions("suspended")).toEqual(["active", "removed"]);
  });

  it("returns empty array for removed (terminal)", () => {
    expect(getAllowedTransitions("removed")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// User status determination
// ---------------------------------------------------------------------------

describe("determineUserStatus", () => {
  it("returns active for normal user", () => {
    const user = makeDirectoryUser({ suspended: false, archived: false });
    expect(determineUserStatus(user)).toBe("active");
  });

  it("returns suspended for suspended user", () => {
    const user = makeDirectoryUser({ suspended: true });
    expect(determineUserStatus(user)).toBe("suspended");
  });

  it("returns suspended for archived user", () => {
    const user = makeDirectoryUser({ archived: true });
    expect(determineUserStatus(user)).toBe("suspended");
  });

  it("returns suspended when both suspended and archived", () => {
    const user = makeDirectoryUser({ suspended: true, archived: true });
    expect(determineUserStatus(user)).toBe("suspended");
  });
});

// ---------------------------------------------------------------------------
// OU filter logic
// ---------------------------------------------------------------------------

describe("filterByOU", () => {
  const users = [
    makeDirectoryUser({ id: "u1", primaryEmail: "a@acme.com", orgUnitPath: "/Engineering" }),
    makeDirectoryUser({ id: "u2", primaryEmail: "b@acme.com", orgUnitPath: "/Engineering/Backend" }),
    makeDirectoryUser({ id: "u3", primaryEmail: "c@acme.com", orgUnitPath: "/Sales" }),
    makeDirectoryUser({ id: "u4", primaryEmail: "d@acme.com", orgUnitPath: "/Sales/EMEA" }),
    makeDirectoryUser({ id: "u5", primaryEmail: "e@acme.com", orgUnitPath: undefined }), // no OU
  ];

  it("returns all users when no OU filter configured (undefined)", () => {
    const result = filterByOU(users, undefined);
    expect(result).toHaveLength(5);
  });

  it("returns all users when OU filter is empty array", () => {
    const result = filterByOU(users, []);
    expect(result).toHaveLength(5);
  });

  it("filters to single OU (exact match)", () => {
    const result = filterByOU(users, ["/Sales"]);
    expect(result).toHaveLength(2);
    expect(result.map((u) => u.primaryEmail)).toEqual(
      expect.arrayContaining(["c@acme.com", "d@acme.com"]),
    );
  });

  it("matches hierarchically (parent OU matches child OUs)", () => {
    const result = filterByOU(users, ["/Engineering"]);
    expect(result).toHaveLength(2);
    expect(result.map((u) => u.primaryEmail)).toEqual(
      expect.arrayContaining(["a@acme.com", "b@acme.com"]),
    );
  });

  it("filters to specific child OU only", () => {
    const result = filterByOU(users, ["/Engineering/Backend"]);
    expect(result).toHaveLength(1);
    expect(result[0].primaryEmail).toBe("b@acme.com");
  });

  it("supports multiple OUs", () => {
    const result = filterByOU(users, ["/Engineering/Backend", "/Sales/EMEA"]);
    expect(result).toHaveLength(2);
    expect(result.map((u) => u.primaryEmail)).toEqual(
      expect.arrayContaining(["b@acme.com", "d@acme.com"]),
    );
  });

  it("excludes users without OU when filter is set", () => {
    const result = filterByOU(users, ["/Engineering"]);
    const emails = result.map((u) => u.primaryEmail);
    expect(emails).not.toContain("e@acme.com");
  });
});

// ---------------------------------------------------------------------------
// Email exclusion filter
// ---------------------------------------------------------------------------

describe("filterExcluded", () => {
  const users = [
    makeDirectoryUser({ id: "u1", primaryEmail: "alice@acme.com" }),
    makeDirectoryUser({ id: "u2", primaryEmail: "bob@acme.com" }),
    makeDirectoryUser({ id: "u3", primaryEmail: "carol@acme.com" }),
  ];

  it("returns all users when no exclusions configured", () => {
    expect(filterExcluded(users, undefined)).toHaveLength(3);
    expect(filterExcluded(users, [])).toHaveLength(3);
  });

  it("excludes specific email addresses", () => {
    const result = filterExcluded(users, ["bob@acme.com"]);
    expect(result).toHaveLength(2);
    expect(result.map((u) => u.primaryEmail)).toEqual(
      expect.arrayContaining(["alice@acme.com", "carol@acme.com"]),
    );
  });

  it("exclusion is case-insensitive", () => {
    const result = filterExcluded(users, ["BOB@ACME.COM"]);
    expect(result).toHaveLength(2);
    expect(result.map((u) => u.primaryEmail)).not.toContain("bob@acme.com");
  });

  it("handles multiple exclusions", () => {
    const result = filterExcluded(users, ["alice@acme.com", "carol@acme.com"]);
    expect(result).toHaveLength(1);
    expect(result[0].primaryEmail).toBe("bob@acme.com");
  });
});

// ---------------------------------------------------------------------------
// Discovery config validation
// ---------------------------------------------------------------------------

describe("DiscoveryConfigSchema", () => {
  it("parses minimal config with defaults", () => {
    const result = parseDiscoveryConfig({
      delegationId: "dlg_test001",
    });

    expect(result.delegationId).toBe("dlg_test001");
    expect(result.syncMode).toBe("lazy"); // default
    expect(result.retentionDays).toBe(30); // default
    expect(result.ouFilter).toBeUndefined();
    expect(result.excludedEmails).toBeUndefined();
  });

  it("parses full config", () => {
    const result = parseDiscoveryConfig({
      delegationId: "dlg_test001",
      ouFilter: ["/Engineering", "/Sales"],
      excludedEmails: ["admin@acme.com", "service@acme.com"],
      syncMode: "proactive",
      retentionDays: 90,
    });

    expect(result.ouFilter).toEqual(["/Engineering", "/Sales"]);
    expect(result.excludedEmails).toEqual(["admin@acme.com", "service@acme.com"]);
    expect(result.syncMode).toBe("proactive");
    expect(result.retentionDays).toBe(90);
  });

  it("rejects invalid sync mode", () => {
    expect(() =>
      parseDiscoveryConfig({
        delegationId: "dlg_test001",
        syncMode: "invalid",
      }),
    ).toThrow();
  });

  it("rejects retention days outside valid range", () => {
    expect(() =>
      parseDiscoveryConfig({
        delegationId: "dlg_test001",
        retentionDays: 0,
      }),
    ).toThrow();

    expect(() =>
      parseDiscoveryConfig({
        delegationId: "dlg_test001",
        retentionDays: 400,
      }),
    ).toThrow();
  });

  it("rejects empty OU filter entries", () => {
    expect(() =>
      parseDiscoveryConfig({
        delegationId: "dlg_test001",
        ouFilter: [""],
      }),
    ).toThrow();
  });

  it("rejects invalid excluded emails", () => {
    expect(() =>
      parseDiscoveryConfig({
        delegationId: "dlg_test001",
        excludedEmails: ["not-an-email"],
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Rate limit constants
// ---------------------------------------------------------------------------

describe("DIRECTORY_API_RATE_LIMITS", () => {
  it("has reasonable defaults", () => {
    expect(DIRECTORY_API_RATE_LIMITS.requestsPerMinute).toBe(60);
    expect(DIRECTORY_API_RATE_LIMITS.maxPageSize).toBe(100);
    expect(DIRECTORY_API_RATE_LIMITS.minDelayMs).toBe(1000);
  });

  it("page size is within Google's maximum (500)", () => {
    expect(DIRECTORY_API_RATE_LIMITS.maxPageSize).toBeLessThanOrEqual(500);
  });
});
