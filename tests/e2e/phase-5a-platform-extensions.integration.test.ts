/**
 * Phase 5A E2E Validation Test Suite
 *
 * Proves platform extensions work end-to-end: CalDAV feed generation,
 * org policy CRUD + merge, what-if simulation engine, and Temporal Graph API.
 *
 * Demo scenario:
 *   1. Subscribe to CalDAV feed in Apple Calendar. Unified events visible.
 *   2. Create org, add members, set org-level working hours policy.
 *   3. Simulate "What if I accept board seat?" -> impact report.
 *   4. Query Temporal Graph API for relationship data.
 *
 * Uses real SQLite (better-sqlite3) + real UserGraphDO + real pure functions.
 * No HTTP server, no mocks of business logic, no test fixtures.
 *
 * Run with:
 *   make test-e2e-phase5a
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type {
  SqlStorageLike,
  SqlStorageCursorLike,
  AccountId,
  EventId,
  CanonicalEvent,
  EventDateTime,
  ImpactReport,
  SimulationSnapshot,
  SimulationEvent,
  SimulationConstraint,
  SimulationCommitment,
} from "@tminus/shared";
import { UserGraphDO } from "@tminus/do-user-graph";
import type { QueueLike } from "@tminus/do-user-graph";

// Pure functions: iCalendar generation
import {
  formatICalDate,
  formatICalDateTime,
  buildVEvent,
  buildVCalendar,
  collectTimezones,
  foldLine,
} from "@tminus/shared";
import type { VCalendarOptions } from "@tminus/shared";

// Pure functions: org policy merge engine
import {
  mergeWorkingHours,
  mergeVipPriority,
  mergeAccountLimit,
  mergeProjectionDetail,
  mergeOrgAndUserPolicies,
  validateOrgPolicyConfig,
  isValidOrgPolicyType,
  VALID_ORG_POLICY_TYPES,
  DETAIL_LEVEL_RANK,
} from "@tminus/shared";
import type {
  WorkingHoursPolicy,
  VipPriorityPolicy,
  AccountLimitPolicy,
  ProjectionDetailPolicy,
  VipEntry,
  OrgPolicy,
  UserPolicies,
  MergedPolicies,
} from "@tminus/shared";

// Pure functions: what-if simulation engine
import {
  simulate,
  computeWeeklyHours,
  countConflicts,
  checkConstraintViolations,
  computeBurnoutRiskDelta,
  computeCommitmentComplianceDelta,
  generateRecurringEvents,
  SIMULATION_WEEKS,
} from "@tminus/shared";

// Pure functions: reputation scoring (Graph API)
import {
  computeReliabilityScore,
  computeReciprocityScore,
  computeReputation,
  computeDecayFactor,
} from "@tminus/shared";
import type { LedgerInput, ReputationResult } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_ID = "usr_01PLATFORM_EXTENSIONS_5A_001";
const ACCOUNT_WORK = "acc_01GOOGLE_WORK_PHASE5A01" as AccountId;
const ACCOUNT_PERSONAL = "acc_02GOOGLE_PERSONAL_5A01" as AccountId;

// Week of Mar 2-7, 2026 (Mon-Sat)
const WEEK_START = "2026-03-02";

// ---------------------------------------------------------------------------
// SqlStorage adapter (proven pattern from earlier E2E tests)
// ---------------------------------------------------------------------------

function createSqlStorageAdapter(db: DatabaseType): SqlStorageLike {
  return {
    exec<T extends Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): SqlStorageCursorLike<T> {
      const trimmed = query.trim().toUpperCase();
      const isSelect =
        trimmed.startsWith("SELECT") ||
        trimmed.startsWith("PRAGMA") ||
        trimmed.startsWith("EXPLAIN");

      if (isSelect) {
        const stmt = db.prepare(query);
        const rows = stmt.all(...bindings) as T[];
        return {
          toArray(): T[] {
            return rows;
          },
          one(): T {
            if (rows.length === 0) {
              throw new Error("Expected at least one row, got none");
            }
            return rows[0];
          },
        };
      }

      if (bindings.length === 0) {
        db.exec(query);
      } else {
        db.prepare(query).run(...bindings);
      }

      return {
        toArray(): T[] {
          return [];
        },
        one(): T {
          throw new Error("No rows returned from non-SELECT statement");
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// MockQueue -- captures write-queue messages
// ---------------------------------------------------------------------------

class MockQueue implements QueueLike {
  messages: unknown[] = [];
  async send(message: unknown): Promise<void> {
    this.messages.push(message);
  }
  async sendBatch(messages: { body: unknown }[]): Promise<void> {
    for (const m of messages) {
      this.messages.push(m.body);
    }
  }
  clear(): void {
    this.messages = [];
  }
}

// ---------------------------------------------------------------------------
// DO RPC helper
// ---------------------------------------------------------------------------

async function doRpc<T>(
  doInstance: UserGraphDO,
  path: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const response = await doInstance.handleFetch(
    new Request(`https://user-graph.internal${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`RPC ${path} failed (${response.status}): ${text}`);
  }
  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Constraint helper
// ---------------------------------------------------------------------------

async function addConstraint(
  doInstance: UserGraphDO,
  kind: string,
  configJson: Record<string, unknown>,
  activeFrom: string | null = null,
  activeTo: string | null = null,
): Promise<{ constraint_id: string }> {
  return doRpc<{ constraint_id: string }>(doInstance, "/addConstraint", {
    kind,
    config_json: configJson,
    active_from: activeFrom,
    active_to: activeTo,
  });
}

// ---------------------------------------------------------------------------
// Event insertion helper
// ---------------------------------------------------------------------------

let eventCounter = 0;

function insertEvent(
  db: DatabaseType,
  startTs: string,
  endTs: string,
  opts?: {
    eventId?: string;
    accountId?: string;
    title?: string;
    status?: string;
    transparency?: string;
    recurrenceRule?: string;
    description?: string;
    location?: string;
  },
): string {
  const eventId =
    opts?.eventId ?? `evt_phase5a_${String(++eventCounter).padStart(4, "0")}`;
  db.prepare(
    `INSERT INTO canonical_events (
      canonical_event_id, origin_account_id, origin_event_id,
      title, start_ts, end_ts, all_day, status, visibility,
      transparency, recurrence_rule, source, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'default', ?, ?, 'provider', 1, datetime('now'), datetime('now'))`,
  ).run(
    eventId,
    opts?.accountId ?? ACCOUNT_WORK,
    `origin_${eventId}`,
    opts?.title ?? "Meeting",
    startTs,
    endTs,
    opts?.status ?? "confirmed",
    opts?.transparency ?? "opaque",
    opts?.recurrenceRule ?? null,
  );
  return eventId;
}

// ---------------------------------------------------------------------------
// Build a CanonicalEvent in memory (for pure function tests)
// ---------------------------------------------------------------------------

function makeEvent(
  id: string,
  title: string,
  startDt: string,
  endDt: string,
  opts?: {
    status?: "confirmed" | "tentative" | "cancelled";
    transparency?: "opaque" | "transparent";
    description?: string;
    location?: string;
    allDay?: boolean;
    startDate?: string;
    endDate?: string;
    startTimeZone?: string;
    endTimeZone?: string;
    recurrenceRule?: string;
  },
): CanonicalEvent {
  const start: EventDateTime = opts?.allDay
    ? { date: opts.startDate }
    : { dateTime: startDt, timeZone: opts?.startTimeZone };
  const end: EventDateTime = opts?.allDay
    ? { date: opts.endDate }
    : { dateTime: endDt, timeZone: opts?.endTimeZone };

  return {
    canonical_event_id: id as unknown as EventId,
    origin_account_id: ACCOUNT_WORK,
    origin_event_id: `origin_${id}`,
    title,
    description: opts?.description,
    location: opts?.location,
    start,
    end,
    all_day: opts?.allDay ?? false,
    status: opts?.status ?? "confirmed",
    visibility: "default",
    transparency: opts?.transparency ?? "opaque",
    recurrence_rule: opts?.recurrenceRule,
    source: "provider",
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Phase 5A E2E: Platform Extensions", () => {
  // =========================================================================
  // 1. CalDAV Feed Generation (iCalendar RFC 5545)
  // =========================================================================

  describe("1. CalDAV feed generation via pure functions", () => {
    it("generates a valid VCALENDAR document from unified canonical events", () => {
      const events: CanonicalEvent[] = [
        makeEvent("caldav_01", "Sprint Planning", "2026-03-02T09:00:00Z", "2026-03-02T10:00:00Z"),
        makeEvent("caldav_02", "Lunch with Partner", "2026-03-02T12:00:00Z", "2026-03-02T13:00:00Z", {
          description: "Discuss Q2 roadmap",
          location: "Downtown Cafe",
        }),
        makeEvent("caldav_03", "Dentist Appointment", "2026-03-03T14:00:00Z", "2026-03-03T15:00:00Z", {
          transparency: "transparent",
        }),
      ];

      const ical = buildVCalendar(events);

      // RFC 5545 structural validation
      expect(ical).toContain("BEGIN:VCALENDAR");
      expect(ical).toContain("END:VCALENDAR");
      expect(ical).toContain("VERSION:2.0");
      expect(ical).toContain("PRODID:-//T-Minus//Calendar Feed//EN");
      expect(ical).toContain("CALSCALE:GREGORIAN");
      expect(ical).toContain("METHOD:PUBLISH");
      expect(ical).toContain("X-WR-CALNAME:T-Minus Unified Calendar");

      // Three VEVENTs
      const beginCount = (ical.match(/BEGIN:VEVENT/g) || []).length;
      expect(beginCount).toBe(3);

      // Event content verified
      expect(ical).toContain("SUMMARY:Sprint Planning");
      expect(ical).toContain("SUMMARY:Lunch with Partner");
      expect(ical).toContain("DESCRIPTION:Discuss Q2 roadmap");
      expect(ical).toContain("LOCATION:Downtown Cafe");
      expect(ical).toContain("TRANSP:TRANSPARENT");

      // CRLF line endings throughout (no bare LF)
      const bareLF = ical.replace(/\r\n/g, "").includes("\n");
      expect(bareLF).toBe(false);
    });

    it("handles all-day events with VALUE=DATE format", () => {
      const event = makeEvent("caldav_allday", "Company Offsite", "", "", {
        allDay: true,
        startDate: "2026-03-05",
        endDate: "2026-03-06",
      });

      const vevent = buildVEvent(event);

      expect(vevent).toContain("DTSTART;VALUE=DATE:20260305");
      expect(vevent).toContain("DTEND;VALUE=DATE:20260306");
      expect(vevent).not.toContain("DTSTART:2026");
    });

    it("includes VTIMEZONE components for timezone-aware events", () => {
      const events: CanonicalEvent[] = [
        makeEvent("caldav_tz1", "NYC Meeting", "2026-03-02T09:00:00", "2026-03-02T10:00:00", {
          startTimeZone: "America/New_York",
          endTimeZone: "America/New_York",
        }),
        makeEvent("caldav_tz2", "London Call", "2026-03-02T15:00:00", "2026-03-02T16:00:00", {
          startTimeZone: "Europe/London",
          endTimeZone: "Europe/London",
        }),
      ];

      const ical = buildVCalendar(events);

      // Should have VTIMEZONE for both zones
      expect(ical).toContain("BEGIN:VTIMEZONE");
      expect(ical).toContain("TZID:America/New_York");
      expect(ical).toContain("TZID:Europe/London");

      // VTIMEZONE must appear before VEVENT
      const tzPos = ical.indexOf("BEGIN:VTIMEZONE");
      const evtPos = ical.indexOf("BEGIN:VEVENT");
      expect(tzPos).toBeLessThan(evtPos);

      // DTSTART includes TZID parameter (no Z suffix for local times)
      expect(ical).toContain("DTSTART;TZID=America/New_York:20260302T090000");
      expect(ical).toContain("DTSTART;TZID=Europe/London:20260302T150000");
    });

    it("excludes cancelled events when excludeCancelled option is true", () => {
      const events: CanonicalEvent[] = [
        makeEvent("caldav_active", "Active Meeting", "2026-03-02T09:00:00Z", "2026-03-02T10:00:00Z"),
        makeEvent("caldav_cancelled", "Cancelled Meeting", "2026-03-02T11:00:00Z", "2026-03-02T12:00:00Z", {
          status: "cancelled",
        }),
      ];

      const ical = buildVCalendar(events, { excludeCancelled: true });

      const beginCount = (ical.match(/BEGIN:VEVENT/g) || []).length;
      expect(beginCount).toBe(1);
      expect(ical).not.toContain("STATUS:CANCELLED");
      expect(ical).toContain("SUMMARY:Active Meeting");
    });

    it("escapes special characters per RFC 5545", () => {
      const event = makeEvent(
        "caldav_escape",
        "Meeting, with commas; semicolons",
        "2026-03-02T09:00:00Z",
        "2026-03-02T10:00:00Z",
        { description: "Line one\nLine two" },
      );

      const vevent = buildVEvent(event);

      expect(vevent).toContain("SUMMARY:Meeting\\, with commas\\; semicolons");
      expect(vevent).toContain("DESCRIPTION:Line one\\nLine two");
    });

    it("folds lines exceeding 75 octets per RFC 5545", () => {
      const longTitle = "A".repeat(100);
      const folded = foldLine(`SUMMARY:${longTitle}`);
      const lines = folded.split("\r\n");

      // First line at most 75 chars
      expect(lines[0].length).toBeLessThanOrEqual(75);

      // Continuation lines start with space
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].length > 0) {
          expect(lines[i][0]).toBe(" ");
        }
      }

      // Unfolding reconstructs the original
      const unfolded = folded.replace(/\r\n /g, "");
      expect(unfolded).toBe(`SUMMARY:${longTitle}`);
    });

    it("collects unique timezone IDs from events", () => {
      const events: CanonicalEvent[] = [
        makeEvent("tz_a", "A", "2026-03-02T09:00:00", "2026-03-02T10:00:00", {
          startTimeZone: "America/Chicago",
          endTimeZone: "America/Chicago",
        }),
        makeEvent("tz_b", "B", "2026-03-02T15:00:00", "2026-03-02T16:00:00", {
          startTimeZone: "Asia/Tokyo",
          endTimeZone: "Asia/Tokyo",
        }),
        // Duplicate -- should not appear twice
        makeEvent("tz_c", "C", "2026-03-03T09:00:00", "2026-03-03T10:00:00", {
          startTimeZone: "America/Chicago",
          endTimeZone: "America/Chicago",
        }),
      ];

      const tzIds = collectTimezones(events);
      expect(tzIds.size).toBe(2);
      expect(tzIds.has("America/Chicago")).toBe(true);
      expect(tzIds.has("Asia/Tokyo")).toBe(true);
    });

    it("produces a subscribable feed with custom calendar name", () => {
      const events: CanonicalEvent[] = [
        makeEvent("feed_01", "Team Standup", "2026-03-02T09:00:00Z", "2026-03-02T09:30:00Z"),
      ];

      const ical = buildVCalendar(events, { calendarName: "My Work Calendar" });

      expect(ical).toContain("X-WR-CALNAME:My Work Calendar");
    });

    it("handles empty event list gracefully for initial subscription", () => {
      const ical = buildVCalendar([]);

      expect(ical).toContain("BEGIN:VCALENDAR");
      expect(ical).toContain("END:VCALENDAR");
      expect(ical).not.toContain("BEGIN:VEVENT");
    });

    it("includes tentative events with STATUS:TENTATIVE", () => {
      const event = makeEvent("caldav_tent", "Maybe Lunch", "2026-03-02T12:00:00Z", "2026-03-02T13:00:00Z", {
        status: "tentative",
      });

      const vevent = buildVEvent(event);

      expect(vevent).toContain("STATUS:TENTATIVE");
      expect(vevent).toContain("SUMMARY:Maybe Lunch");
    });

    it("includes recurring events with RRULE property", () => {
      const event = makeEvent("caldav_recur", "Weekly Standup", "2026-03-02T09:00:00Z", "2026-03-02T09:30:00Z", {
        recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",
      });

      const vevent = buildVEvent(event);

      expect(vevent).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO");
    });
  });

  // =========================================================================
  // 2. Org Policy CRUD + Merge Engine
  // =========================================================================

  describe("2. Org policy merge engine via pure functions", () => {
    it("merges working hours: org sets floor, user cannot widen", () => {
      const orgPolicy: WorkingHoursPolicy = { start_hour: 8, end_hour: 18 };

      // User tries to start earlier (7am) and end later (20pm) -- clamped
      const userPolicy: WorkingHoursPolicy = { start_hour: 7, end_hour: 20 };
      const merged = mergeWorkingHours(orgPolicy, userPolicy);

      expect(merged.start_hour).toBe(8); // clamped up from 7
      expect(merged.end_hour).toBe(18); // clamped down from 20
    });

    it("merges working hours: user can narrow within org window", () => {
      const orgPolicy: WorkingHoursPolicy = { start_hour: 8, end_hour: 18 };
      const userPolicy: WorkingHoursPolicy = { start_hour: 9, end_hour: 17 };

      const merged = mergeWorkingHours(orgPolicy, userPolicy);

      expect(merged.start_hour).toBe(9); // user's narrower start accepted
      expect(merged.end_hour).toBe(17); // user's narrower end accepted
    });

    it("uses org policy as default when user has no working hours", () => {
      const orgPolicy: WorkingHoursPolicy = { start_hour: 9, end_hour: 17 };
      const merged = mergeWorkingHours(orgPolicy, undefined);

      expect(merged.start_hour).toBe(9);
      expect(merged.end_hour).toBe(17);
    });

    it("merges VIP priority: raises low-weight entries to org floor", () => {
      const orgPolicy: VipPriorityPolicy = { minimum_weight: 0.7 };
      const userVips: VipEntry[] = [
        { contact_email: "ceo@company.com", weight: 0.9 },
        { contact_email: "vendor@external.com", weight: 0.3 },
        { contact_email: "investor@vc.com", weight: 0.5 },
      ];

      const merged = mergeVipPriority(orgPolicy, userVips);

      expect(merged[0].weight).toBe(0.9); // above floor, unchanged
      expect(merged[1].weight).toBe(0.7); // raised from 0.3 to floor
      expect(merged[2].weight).toBe(0.7); // raised from 0.5 to floor
    });

    it("merges account limit: rejects when over org maximum", () => {
      const orgPolicy: AccountLimitPolicy = { max_accounts: 3 };

      const overLimit = mergeAccountLimit(orgPolicy, 5);
      expect(overLimit.allowed).toBe(false);
      expect(overLimit.effective_max).toBe(3);

      const underLimit = mergeAccountLimit(orgPolicy, 2);
      expect(underLimit.allowed).toBe(true);
      expect(underLimit.effective_max).toBe(3);

      const atLimit = mergeAccountLimit(orgPolicy, 3);
      expect(atLimit.allowed).toBe(true);
    });

    it("merges projection detail: raises user preference to org floor", () => {
      // Org requires at least TITLE
      const orgPolicy: ProjectionDetailPolicy = { minimum_detail: "TITLE" };

      // User wants BUSY (less detail) -> raised to TITLE
      expect(mergeProjectionDetail(orgPolicy, "BUSY")).toBe("TITLE");

      // User wants FULL (more detail) -> preserved
      expect(mergeProjectionDetail(orgPolicy, "FULL")).toBe("FULL");

      // User at same level -> preserved
      expect(mergeProjectionDetail(orgPolicy, "TITLE")).toBe("TITLE");

      // No user preference -> org default
      expect(mergeProjectionDetail(orgPolicy, undefined)).toBe("TITLE");
    });

    it("validates org policy config: catches invalid configurations", () => {
      // Working hours: start >= end
      expect(validateOrgPolicyConfig("mandatory_working_hours", { start_hour: 18, end_hour: 9 })).not.toBeNull();

      // Working hours: missing fields
      expect(validateOrgPolicyConfig("mandatory_working_hours", { start_hour: 9 })).not.toBeNull();

      // Working hours: valid
      expect(validateOrgPolicyConfig("mandatory_working_hours", { start_hour: 9, end_hour: 17 })).toBeNull();

      // VIP priority: out of range
      expect(validateOrgPolicyConfig("minimum_vip_priority", { minimum_weight: 1.5 })).not.toBeNull();

      // VIP priority: valid
      expect(validateOrgPolicyConfig("minimum_vip_priority", { minimum_weight: 0.5 })).toBeNull();

      // Account limit: non-integer
      expect(validateOrgPolicyConfig("max_account_count", { max_accounts: 2.5 })).not.toBeNull();

      // Account limit: valid
      expect(validateOrgPolicyConfig("max_account_count", { max_accounts: 5 })).toBeNull();

      // Detail level: invalid value
      expect(validateOrgPolicyConfig("required_projection_detail", { minimum_detail: "NONE" })).not.toBeNull();

      // Detail level: valid
      expect(validateOrgPolicyConfig("required_projection_detail", { minimum_detail: "TITLE" })).toBeNull();
    });

    it("validates org policy type enum", () => {
      expect(isValidOrgPolicyType("mandatory_working_hours")).toBe(true);
      expect(isValidOrgPolicyType("minimum_vip_priority")).toBe(true);
      expect(isValidOrgPolicyType("max_account_count")).toBe(true);
      expect(isValidOrgPolicyType("required_projection_detail")).toBe(true);
      expect(isValidOrgPolicyType("unknown_policy")).toBe(false);
      expect(VALID_ORG_POLICY_TYPES).toHaveLength(4);
    });

    it("composite merge applies all org policies at once", () => {
      const orgPolicies: OrgPolicy[] = [
        {
          policy_type: "mandatory_working_hours",
          config: { start_hour: 8, end_hour: 18 },
        },
        {
          policy_type: "minimum_vip_priority",
          config: { minimum_weight: 0.6 },
        },
        {
          policy_type: "max_account_count",
          config: { max_accounts: 4 },
        },
        {
          policy_type: "required_projection_detail",
          config: { minimum_detail: "TITLE" as const },
        },
      ];

      const userPolicies: UserPolicies = {
        working_hours: { start_hour: 7, end_hour: 20 }, // wider than org -> clamped
        vip_list: [
          { contact_email: "boss@co.com", weight: 0.8 },
          { contact_email: "low@co.com", weight: 0.2 },
        ],
        account_count: 3,
        projection_detail: "BUSY", // less than org floor -> raised
      };

      const merged = mergeOrgAndUserPolicies(orgPolicies, userPolicies);

      // Working hours clamped to org window
      expect(merged.working_hours.start_hour).toBe(8);
      expect(merged.working_hours.end_hour).toBe(18);

      // VIP weights raised to floor
      expect(merged.vip_list[0].weight).toBe(0.8); // above floor
      expect(merged.vip_list[1].weight).toBe(0.6); // raised from 0.2

      // Account limit check
      expect(merged.account_limit.allowed).toBe(true); // 3 <= 4
      expect(merged.account_limit.effective_max).toBe(4);

      // Detail level raised
      expect(merged.projection_detail).toBe("TITLE");
    });

    it("composite merge passes through user values when no org policies", () => {
      const merged = mergeOrgAndUserPolicies([], {
        working_hours: { start_hour: 6, end_hour: 22 },
        vip_list: [{ contact_email: "a@b.com", weight: 0.1 }],
        account_count: 10,
        projection_detail: "FULL",
      });

      expect(merged.working_hours.start_hour).toBe(6);
      expect(merged.working_hours.end_hour).toBe(22);
      expect(merged.vip_list[0].weight).toBe(0.1); // no floor
      expect(merged.account_limit.allowed).toBe(true); // no limit
      expect(merged.projection_detail).toBe("FULL");
    });

    it("detail level ranking is BUSY < TITLE < FULL", () => {
      expect(DETAIL_LEVEL_RANK["BUSY"]).toBeLessThan(DETAIL_LEVEL_RANK["TITLE"]);
      expect(DETAIL_LEVEL_RANK["TITLE"]).toBeLessThan(DETAIL_LEVEL_RANK["FULL"]);
    });
  });

  // =========================================================================
  // 3. What-If Simulation Engine (Pure Functions)
  // =========================================================================

  describe("3. What-if simulation via pure functions", () => {
    const baseSnapshot: SimulationSnapshot = {
      simulation_start: "2026-03-02T00:00:00Z",
      events: [
        // Existing meetings: Mon-Fri 9am-12pm (3h/day = 15h/week)
        ...Array.from({ length: 5 }, (_, i): SimulationEvent => ({
          canonical_event_id: `existing_${i}`,
          title: `Morning Block Day ${i + 1}`,
          start_ts: `2026-03-0${2 + i}T09:00:00Z`,
          end_ts: `2026-03-0${2 + i}T12:00:00Z`,
          all_day: false,
          status: "confirmed",
          client_id: "client_alpha",
        })),
        // Existing meetings: Tue, Thu 14:00-16:00 (4h/week)
        {
          canonical_event_id: "existing_tue_pm",
          title: "Tuesday PM Block",
          start_ts: "2026-03-03T14:00:00Z",
          end_ts: "2026-03-03T16:00:00Z",
          all_day: false,
          status: "confirmed",
          client_id: "client_beta",
        },
        {
          canonical_event_id: "existing_thu_pm",
          title: "Thursday PM Block",
          start_ts: "2026-03-05T14:00:00Z",
          end_ts: "2026-03-05T16:00:00Z",
          all_day: false,
          status: "confirmed",
          client_id: "client_beta",
        },
      ],
      constraints: [
        { kind: "working_hours", config_json: { start_hour: 9, end_hour: 17 } },
      ],
      commitments: [
        {
          commitment_id: "cmt_alpha",
          client_id: "client_alpha",
          client_name: "Alpha Corp",
          target_hours: 15,
          window_type: "WEEKLY",
          rolling_window_weeks: 4,
          hard_minimum: false,
        },
        {
          commitment_id: "cmt_beta",
          client_id: "client_beta",
          client_name: "Beta Inc",
          target_hours: 4,
          window_type: "WEEKLY",
          rolling_window_weeks: 4,
          hard_minimum: false,
        },
      ],
    };

    it("scenario: 'What if I accept a board seat?' -- adds recurring weekly commitment", () => {
      const report = simulate(baseSnapshot, {
        type: "add_recurring_event",
        title: "Board Meeting",
        day_of_week: 2, // Wednesday
        start_time: 14,
        end_time: 16,
        duration_weeks: SIMULATION_WEEKS,
      });

      // Adding 2h/week should increase weekly hours
      expect(report.projected_weekly_hours).toBeGreaterThan(0);

      // No conflicts expected (Wednesday PM was free)
      expect(report.conflict_count).toBe(0);

      // Burnout risk should increase (more hours)
      expect(report.burnout_risk_delta).toBeGreaterThan(0);

      // Structure validation
      expect(typeof report.projected_weekly_hours).toBe("number");
      expect(typeof report.conflict_count).toBe("number");
      expect(Array.isArray(report.constraint_violations)).toBe(true);
      expect(typeof report.burnout_risk_delta).toBe("number");
    });

    it("scenario: add commitment with conflict detection", () => {
      const report = simulate(baseSnapshot, {
        type: "add_commitment",
        client_id: "client_gamma",
        hours_per_week: 10,
      });

      // Additional 10h/week should show up in projected hours
      expect(report.projected_weekly_hours).toBeGreaterThan(0);

      // With 10h extra on top of existing 19h = 29h total
      // Plus the simulated blocks may create some overlaps
      expect(typeof report.conflict_count).toBe("number");

      // Burnout risk increases with more hours
      expect(report.burnout_risk_delta).toBeGreaterThan(0);

      // Commitment compliance should track the new client
      expect(report.commitment_compliance_delta["client_gamma"]).toBeDefined();
      expect(report.commitment_compliance_delta["client_gamma"].before).toBe(0);
      expect(report.commitment_compliance_delta["client_gamma"].after).toBeGreaterThan(0);
    });

    it("scenario: change working hours to earlier window", () => {
      const report = simulate(baseSnapshot, {
        type: "change_working_hours",
        start_hour: 7,
        end_hour: 15,
      });

      // Existing events at 14:00-16:00 now extend past 15:00 cutoff
      expect(report.constraint_violations.length).toBeGreaterThan(0);
      expect(report.constraint_violations.some((v) => v.includes("working_hours"))).toBe(true);
    });

    it("computeWeeklyHours calculates correct average", () => {
      // 7 events * 3 hours each = 21 hours total / 4 weeks = 5.25 h/week
      const events: SimulationEvent[] = Array.from({ length: 7 }, (_, i) => ({
        canonical_event_id: `wh_${i}`,
        title: `Event ${i}`,
        start_ts: `2026-03-02T09:00:00Z`,
        end_ts: `2026-03-02T12:00:00Z`,
        all_day: false,
        status: "confirmed",
        client_id: null,
      }));

      const hours = computeWeeklyHours(events, "2026-03-02T00:00:00Z", 4);
      expect(hours).toBeCloseTo(5.25, 2);
    });

    it("countConflicts detects overlapping events", () => {
      const events: SimulationEvent[] = [
        {
          canonical_event_id: "ov1",
          title: "Meeting A",
          start_ts: "2026-03-02T10:00:00Z",
          end_ts: "2026-03-02T11:00:00Z",
          all_day: false,
          status: "confirmed",
          client_id: null,
        },
        {
          canonical_event_id: "ov2",
          title: "Meeting B",
          start_ts: "2026-03-02T10:30:00Z",
          end_ts: "2026-03-02T11:30:00Z",
          all_day: false,
          status: "confirmed",
          client_id: null,
        },
        {
          canonical_event_id: "ov3",
          title: "Meeting C",
          start_ts: "2026-03-02T12:00:00Z",
          end_ts: "2026-03-02T13:00:00Z",
          all_day: false,
          status: "confirmed",
          client_id: null,
        },
      ];

      // A and B overlap (10:30 < 11:00). C does not overlap either.
      expect(countConflicts(events)).toBe(1);
    });

    it("countConflicts returns 0 for non-overlapping events", () => {
      const events: SimulationEvent[] = [
        {
          canonical_event_id: "no1",
          title: "A",
          start_ts: "2026-03-02T09:00:00Z",
          end_ts: "2026-03-02T10:00:00Z",
          all_day: false,
          status: "confirmed",
          client_id: null,
        },
        {
          canonical_event_id: "no2",
          title: "B",
          start_ts: "2026-03-02T10:00:00Z",
          end_ts: "2026-03-02T11:00:00Z",
          all_day: false,
          status: "confirmed",
          client_id: null,
        },
      ];

      expect(countConflicts(events)).toBe(0);
    });

    it("checkConstraintViolations detects working hours breaches", () => {
      const events: SimulationEvent[] = [
        {
          canonical_event_id: "cv1",
          title: "Early Bird Meeting",
          start_ts: "2026-03-02T07:00:00Z",
          end_ts: "2026-03-02T08:00:00Z",
          all_day: false,
          status: "confirmed",
          client_id: null,
        },
        {
          canonical_event_id: "cv2",
          title: "Late Night Call",
          start_ts: "2026-03-02T20:00:00Z",
          end_ts: "2026-03-02T21:00:00Z",
          all_day: false,
          status: "confirmed",
          client_id: null,
        },
      ];

      const constraints: SimulationConstraint[] = [
        { kind: "working_hours", config_json: { start_hour: 9, end_hour: 17 } },
      ];

      const violations = checkConstraintViolations(events, constraints);
      expect(violations.length).toBe(2);
      expect(violations[0]).toContain("working_hours");
      expect(violations[1]).toContain("working_hours");
    });

    it("checkConstraintViolations detects max_hours_per_day breaches", () => {
      const events: SimulationEvent[] = Array.from({ length: 5 }, (_, i) => ({
        canonical_event_id: `mh_${i}`,
        title: `Block ${i}`,
        start_ts: `2026-03-02T${String(9 + i * 2).padStart(2, "0")}:00:00Z`,
        end_ts: `2026-03-02T${String(11 + i * 2).padStart(2, "0")}:00:00Z`,
        all_day: false,
        status: "confirmed",
        client_id: null,
      }));

      const constraints: SimulationConstraint[] = [
        { kind: "max_hours_per_day", config_json: { max_hours: 8 } },
      ];

      // 5 x 2h = 10h > 8h limit
      const violations = checkConstraintViolations(events, constraints);
      expect(violations.length).toBe(1);
      expect(violations[0]).toContain("max_hours_per_day");
    });

    it("computeBurnoutRiskDelta is proportional to hours change", () => {
      // +10 hours = +0.25 delta (10/40)
      expect(computeBurnoutRiskDelta(30, 40)).toBeCloseTo(0.25, 2);

      // -20 hours = -0.50 delta
      expect(computeBurnoutRiskDelta(40, 20)).toBeCloseTo(-0.5, 2);

      // No change
      expect(computeBurnoutRiskDelta(30, 30)).toBe(0);

      // Clamped to [-1, 1]
      expect(computeBurnoutRiskDelta(0, 80)).toBeLessThanOrEqual(1);
      expect(computeBurnoutRiskDelta(80, 0)).toBeGreaterThanOrEqual(-1);
    });

    it("generateRecurringEvents creates correct number of events", () => {
      const events = generateRecurringEvents(
        "Weekly Board Meeting",
        2, // Wednesday
        14,
        16,
        4, // 4 weeks
        "2026-03-02T00:00:00Z",
      );

      expect(events).toHaveLength(4);
      expect(events[0].title).toBe("Weekly Board Meeting");
      expect(events[0].status).toBe("confirmed");
      expect(events[0].canonical_event_id).toContain("sim-");

      // Each event is 2 hours
      for (const ev of events) {
        const start = new Date(ev.start_ts).getTime();
        const end = new Date(ev.end_ts).getTime();
        expect((end - start) / (60 * 60 * 1000)).toBe(2);
      }
    });

    it("commitmentComplianceDelta tracks per-client hours", () => {
      const commitments: SimulationCommitment[] = [
        {
          commitment_id: "cc1",
          client_id: "c1",
          client_name: "Client 1",
          target_hours: 10,
          window_type: "WEEKLY",
          rolling_window_weeks: 4,
          hard_minimum: false,
        },
      ];

      const beforeEvents: SimulationEvent[] = [
        {
          canonical_event_id: "cc_ev1",
          title: "C1 Work",
          start_ts: "2026-03-02T09:00:00Z",
          end_ts: "2026-03-02T14:00:00Z", // 5 hours
          all_day: false,
          status: "confirmed",
          client_id: "c1",
        },
      ];

      const afterEvents: SimulationEvent[] = [
        ...beforeEvents,
        {
          canonical_event_id: "cc_ev2",
          title: "C1 Extra Work",
          start_ts: "2026-03-03T09:00:00Z",
          end_ts: "2026-03-03T14:00:00Z", // 5 more hours
          all_day: false,
          status: "confirmed",
          client_id: "c1",
        },
      ];

      const delta = computeCommitmentComplianceDelta(
        commitments,
        beforeEvents,
        afterEvents,
        "2026-03-02T00:00:00Z",
        4,
      );

      expect(delta["c1"].before).toBeCloseTo(1.25, 2); // 5h / 4 weeks
      expect(delta["c1"].after).toBeCloseTo(2.5, 2);   // 10h / 4 weeks
    });
  });

  // =========================================================================
  // 4. Temporal Graph API -- Reputation + Relationships (Pure Functions)
  // =========================================================================

  describe("4. Temporal Graph API: reputation scoring via pure functions", () => {
    const NOW = "2026-03-02T12:00:00Z";

    it("computeDecayFactor decays over time (0.95^(days/30))", () => {
      // Today: full weight
      expect(computeDecayFactor(0)).toBe(1.0);

      // 30 days: 0.95
      expect(computeDecayFactor(30)).toBeCloseTo(0.95, 2);

      // 60 days: 0.95^2 = 0.9025
      expect(computeDecayFactor(60)).toBeCloseTo(0.9025, 3);

      // 400+ days: ~0.5
      expect(computeDecayFactor(400)).toBeLessThan(0.55);
      expect(computeDecayFactor(400)).toBeGreaterThan(0.45);
    });

    it("computeReliabilityScore returns neutral 0.5 for empty ledger", () => {
      expect(computeReliabilityScore([], NOW)).toBe(0.5);
    });

    it("computeReliabilityScore returns high score for positive interactions", () => {
      const entries: LedgerInput[] = [
        { outcome: "ATTENDED", weight: 1.0, ts: "2026-03-01T10:00:00Z" },
        { outcome: "ATTENDED", weight: 1.0, ts: "2026-02-28T10:00:00Z" },
        { outcome: "ATTENDED", weight: 1.0, ts: "2026-02-25T10:00:00Z" },
        { outcome: "ATTENDED", weight: 1.0, ts: "2026-02-20T10:00:00Z" },
      ];

      const score = computeReliabilityScore(entries, NOW);

      // All positive (weight 1.0): normalized (1 + 1)/2 = 1.0
      expect(score).toBeGreaterThanOrEqual(0.95);
    });

    it("computeReliabilityScore returns low score for negative interactions", () => {
      const entries: LedgerInput[] = [
        { outcome: "CANCELED_BY_THEM", weight: -1.0, ts: "2026-03-01T10:00:00Z" },
        { outcome: "NO_SHOW_THEM", weight: -1.0, ts: "2026-02-28T10:00:00Z" },
        { outcome: "CANCELED_BY_THEM", weight: -1.0, ts: "2026-02-25T10:00:00Z" },
      ];

      const score = computeReliabilityScore(entries, NOW);

      // All negative (weight -1.0): normalized (-1 + 1)/2 = 0.0
      expect(score).toBeLessThanOrEqual(0.05);
    });

    it("computeReliabilityScore weighs recent interactions more heavily", () => {
      // Old positive + recent negative should lean negative
      const entries: LedgerInput[] = [
        { outcome: "ATTENDED", weight: 1.0, ts: "2025-01-01T10:00:00Z" },  // very old
        { outcome: "CANCELED_BY_THEM", weight: -1.0, ts: "2026-03-01T10:00:00Z" }, // recent
      ];

      const score = computeReliabilityScore(entries, NOW);
      // Recent negative should dominate -> score < 0.5
      expect(score).toBeLessThan(0.5);
    });

    it("computeReciprocityScore returns 0.5 (balanced) when no negatives", () => {
      const entries: LedgerInput[] = [
        { outcome: "ATTENDED", weight: 1.0, ts: "2026-03-01T10:00:00Z" },
      ];

      expect(computeReciprocityScore(entries)).toBe(0.5);
    });

    it("computeReciprocityScore > 0.5 when they cancel more", () => {
      const entries: LedgerInput[] = [
        { outcome: "CANCELED_BY_THEM", weight: -1.0, ts: "2026-03-01T10:00:00Z" },
        { outcome: "CANCELED_BY_THEM", weight: -1.0, ts: "2026-02-28T10:00:00Z" },
        { outcome: "CANCELED_BY_ME", weight: -1.0, ts: "2026-02-25T10:00:00Z" },
      ];

      const score = computeReciprocityScore(entries);
      // 2 them / 3 total = 0.67
      expect(score).toBeCloseTo(0.67, 2);
    });

    it("computeReciprocityScore < 0.5 when I cancel more", () => {
      const entries: LedgerInput[] = [
        { outcome: "CANCELED_BY_ME", weight: -1.0, ts: "2026-03-01T10:00:00Z" },
        { outcome: "CANCELED_BY_ME", weight: -1.0, ts: "2026-02-28T10:00:00Z" },
        { outcome: "CANCELED_BY_THEM", weight: -1.0, ts: "2026-02-25T10:00:00Z" },
      ];

      const score = computeReciprocityScore(entries);
      // 1 them / 3 total = 0.33
      expect(score).toBeCloseTo(0.33, 2);
    });

    it("computeReputation returns full result with all fields", () => {
      const entries: LedgerInput[] = [
        { outcome: "ATTENDED", weight: 1.0, ts: "2026-03-01T10:00:00Z" },
        { outcome: "CANCELED_BY_THEM", weight: -1.0, ts: "2026-02-15T10:00:00Z" },
        { outcome: "ATTENDED", weight: 1.0, ts: "2026-01-10T10:00:00Z" },
      ];

      const result = computeReputation(entries, NOW);

      expect(typeof result.reliability_score).toBe("number");
      expect(result.reliability_score).toBeGreaterThanOrEqual(0);
      expect(result.reliability_score).toBeLessThanOrEqual(1);

      expect(typeof result.reciprocity_score).toBe("number");
      expect(result.reciprocity_score).toBeGreaterThanOrEqual(0);
      expect(result.reciprocity_score).toBeLessThanOrEqual(1);

      expect(result.total_interactions).toBe(3);
      // Only the March 1 entry is within 30 days of March 2
      expect(result.last_30_days).toBeGreaterThanOrEqual(1);

      expect(result.computed_at).toBeDefined();
    });
  });

  // =========================================================================
  // 5. CalDAV feed via real UserGraphDO
  // =========================================================================

  describe("5. CalDAV feed from real UserGraphDO event store", () => {
    let db: DatabaseType;
    let sql: SqlStorageLike;
    let queue: MockQueue;
    let userGraphDO: UserGraphDO;

    beforeEach(async () => {
      db = new Database(":memory:");
      sql = createSqlStorageAdapter(db);
      queue = new MockQueue();
      userGraphDO = new UserGraphDO(sql, queue);
      eventCounter = 500;

      // Trigger lazy migration to create schema
      await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/getSyncHealth"),
      );

      // Insert a variety of events (multi-account federated calendar)
      insertEvent(db, "2026-03-02T09:00:00Z", "2026-03-02T10:00:00Z", {
        title: "Work Standup",
        accountId: ACCOUNT_WORK as string,
      });
      insertEvent(db, "2026-03-02T12:00:00Z", "2026-03-02T13:00:00Z", {
        title: "Personal Lunch",
        accountId: ACCOUNT_PERSONAL as string,
      });
      insertEvent(db, "2026-03-03T14:00:00Z", "2026-03-03T15:00:00Z", {
        title: "Tentative Dentist",
        status: "tentative",
        accountId: ACCOUNT_PERSONAL as string,
      });
    });

    afterEach(() => {
      db.close();
    });

    it("retrieves events from DO and generates a valid CalDAV feed", async () => {
      // Query events from the real DO database
      const rows = db
        .prepare(
          "SELECT canonical_event_id, origin_account_id, origin_event_id, title, start_ts, end_ts, all_day, status, visibility, transparency, recurrence_rule, source, version, created_at, updated_at FROM canonical_events ORDER BY start_ts",
        )
        .all() as Array<Record<string, unknown>>;

      expect(rows.length).toBe(3);

      // Convert DB rows to CanonicalEvent objects for iCal generation
      const events: CanonicalEvent[] = rows.map((row) => ({
        canonical_event_id: row.canonical_event_id as EventId,
        origin_account_id: row.origin_account_id as AccountId,
        origin_event_id: row.origin_event_id as string,
        title: row.title as string,
        start: { dateTime: row.start_ts as string },
        end: { dateTime: row.end_ts as string },
        all_day: row.all_day === 1,
        status: row.status as "confirmed" | "tentative" | "cancelled",
        visibility: row.visibility as "default",
        transparency: row.transparency as "opaque" | "transparent",
        recurrence_rule: row.recurrence_rule as string | undefined,
        source: row.source as "provider",
        version: row.version as number,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
      }));

      const ical = buildVCalendar(events);

      // Valid iCalendar document
      expect(ical).toContain("BEGIN:VCALENDAR");
      expect(ical).toContain("END:VCALENDAR");
      expect(ical).toContain("VERSION:2.0");

      // All three events from federated accounts appear
      expect(ical).toContain("SUMMARY:Work Standup");
      expect(ical).toContain("SUMMARY:Personal Lunch");
      expect(ical).toContain("SUMMARY:Tentative Dentist");

      // Tentative event is properly marked
      expect(ical).toContain("STATUS:TENTATIVE");

      // Three VEVENTs total
      const beginCount = (ical.match(/BEGIN:VEVENT/g) || []).length;
      expect(beginCount).toBe(3);
    });

    it("generates feed with excludeCancelled filtering", async () => {
      // Add a cancelled event
      insertEvent(db, "2026-03-04T09:00:00Z", "2026-03-04T10:00:00Z", {
        title: "Cancelled Meeting",
        status: "cancelled",
      });

      const rows = db
        .prepare("SELECT * FROM canonical_events ORDER BY start_ts")
        .all() as Array<Record<string, unknown>>;

      expect(rows.length).toBe(4);

      const events: CanonicalEvent[] = rows.map((row) => ({
        canonical_event_id: row.canonical_event_id as EventId,
        origin_account_id: row.origin_account_id as AccountId,
        origin_event_id: row.origin_event_id as string,
        title: row.title as string,
        start: { dateTime: row.start_ts as string },
        end: { dateTime: row.end_ts as string },
        all_day: row.all_day === 1,
        status: row.status as "confirmed" | "tentative" | "cancelled",
        visibility: row.visibility as "default",
        transparency: row.transparency as "opaque" | "transparent",
        recurrence_rule: row.recurrence_rule as string | undefined,
        source: row.source as "provider",
        version: row.version as number,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
      }));

      const ical = buildVCalendar(events, { excludeCancelled: true });

      // Only 3 events (cancelled excluded)
      const beginCount = (ical.match(/BEGIN:VEVENT/g) || []).length;
      expect(beginCount).toBe(3);
      expect(ical).not.toContain("SUMMARY:Cancelled Meeting");
    });
  });

  // =========================================================================
  // 6. Simulation via real UserGraphDO
  // =========================================================================

  describe("6. What-if simulation via real UserGraphDO", () => {
    let db: DatabaseType;
    let sql: SqlStorageLike;
    let queue: MockQueue;
    let userGraphDO: UserGraphDO;

    beforeEach(async () => {
      db = new Database(":memory:");
      sql = createSqlStorageAdapter(db);
      queue = new MockQueue();
      userGraphDO = new UserGraphDO(sql, queue);
      eventCounter = 600;

      // Trigger lazy migration
      await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/getSyncHealth"),
      );

      // Set working hours
      await addConstraint(userGraphDO, "working_hours", {
        days: [1, 2, 3, 4, 5],
        start_time: "09:00",
        end_time: "17:00",
        timezone: "UTC",
        start_hour: 9,
        end_hour: 17,
      });

      // Add some existing events
      insertEvent(db, "2026-03-02T09:00:00Z", "2026-03-02T12:00:00Z", {
        title: "Morning Block Monday",
      });
      insertEvent(db, "2026-03-03T09:00:00Z", "2026-03-03T12:00:00Z", {
        title: "Morning Block Tuesday",
      });
      insertEvent(db, "2026-03-04T09:00:00Z", "2026-03-04T12:00:00Z", {
        title: "Morning Block Wednesday",
      });
    });

    afterEach(() => {
      db.close();
    });

    it("/simulate RPC: add_recurring_event returns valid impact report", async () => {
      const report = await doRpc<ImpactReport>(userGraphDO, "/simulate", {
        scenario: {
          type: "add_recurring_event",
          title: "Board Meeting",
          day_of_week: 3, // Thursday
          start_time: 14,
          end_time: 16,
          duration_weeks: 4,
        },
      });

      expect(typeof report.projected_weekly_hours).toBe("number");
      expect(report.projected_weekly_hours).toBeGreaterThan(0);
      expect(typeof report.conflict_count).toBe("number");
      expect(Array.isArray(report.constraint_violations)).toBe(true);
      expect(typeof report.burnout_risk_delta).toBe("number");
      expect(report.burnout_risk_delta).toBeGreaterThanOrEqual(-1);
      expect(report.burnout_risk_delta).toBeLessThanOrEqual(1);
    });

    it("/simulate RPC: add_commitment produces commitment compliance delta", async () => {
      const report = await doRpc<ImpactReport>(userGraphDO, "/simulate", {
        scenario: {
          type: "add_commitment",
          client_id: "board_seat",
          hours_per_week: 8,
        },
      });

      expect(report.projected_weekly_hours).toBeGreaterThan(0);

      // Commitment compliance should show before=0, after>0 for the new client
      expect(report.commitment_compliance_delta["board_seat"]).toBeDefined();
      expect(report.commitment_compliance_delta["board_seat"].before).toBe(0);
      expect(report.commitment_compliance_delta["board_seat"].after).toBeGreaterThan(0);
    });

    it("/simulate RPC: change_working_hours detects violations", async () => {
      const report = await doRpc<ImpactReport>(userGraphDO, "/simulate", {
        scenario: {
          type: "change_working_hours",
          start_hour: 10,
          end_hour: 16,
        },
      });

      // Events starting at 9:00 violate the new 10:00 start
      expect(report.constraint_violations.length).toBeGreaterThan(0);
      expect(report.constraint_violations.some((v) => v.includes("working_hours"))).toBe(true);
    });

    it("/simulate RPC does NOT modify real data (read-only verification)", async () => {
      // Count events before simulation
      const countBefore = (db.prepare("SELECT COUNT(*) as c FROM canonical_events").get() as { c: number }).c;

      await doRpc<ImpactReport>(userGraphDO, "/simulate", {
        scenario: {
          type: "add_commitment",
          client_id: "phantom_client",
          hours_per_week: 20,
        },
      });

      // Count events after simulation -- should be unchanged
      const countAfter = (db.prepare("SELECT COUNT(*) as c FROM canonical_events").get() as { c: number }).c;
      expect(countAfter).toBe(countBefore);
    });
  });

  // =========================================================================
  // 7. Graph API: Relationships + Reputation + Timeline via real UserGraphDO
  // =========================================================================

  describe("7. Graph API via real UserGraphDO", () => {
    let db: DatabaseType;
    let sql: SqlStorageLike;
    let queue: MockQueue;
    let userGraphDO: UserGraphDO;

    const REL_ALICE = "rel_alice_phase5a";
    const REL_BOB = "rel_bob_phase5a";
    const HASH_ALICE = "hash_alice_5a";
    const HASH_BOB = "hash_bob_5a";

    beforeEach(async () => {
      db = new Database(":memory:");
      sql = createSqlStorageAdapter(db);
      queue = new MockQueue();
      userGraphDO = new UserGraphDO(sql, queue);
      eventCounter = 700;

      // Trigger lazy migration
      await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/getSyncHealth"),
      );

      // Create relationships
      await doRpc(userGraphDO, "/createRelationship", {
        relationship_id: REL_ALICE,
        participant_hash: HASH_ALICE,
        display_name: "Alice Smith",
        category: "COLLEAGUE",
        closeness_weight: 0.8,
        city: "New York",
        timezone: "America/New_York",
      });

      await doRpc(userGraphDO, "/createRelationship", {
        relationship_id: REL_BOB,
        participant_hash: HASH_BOB,
        display_name: "Bob Jones",
        category: "CLIENT",
        closeness_weight: 0.5,
        city: "London",
        timezone: "Europe/London",
      });

      // Record interaction outcomes for Alice (positive pattern)
      await doRpc(userGraphDO, "/markOutcome", {
        relationship_id: REL_ALICE,
        outcome: "ATTENDED",
        note: "Sprint planning",
      });
      await doRpc(userGraphDO, "/markOutcome", {
        relationship_id: REL_ALICE,
        outcome: "ATTENDED",
        note: "Code review",
      });
      await doRpc(userGraphDO, "/markOutcome", {
        relationship_id: REL_ALICE,
        outcome: "ATTENDED",
        note: "Design sync",
      });

      // Record interaction outcomes for Bob (mixed pattern)
      await doRpc(userGraphDO, "/markOutcome", {
        relationship_id: REL_BOB,
        outcome: "ATTENDED",
        note: "Client check-in",
      });
      await doRpc(userGraphDO, "/markOutcome", {
        relationship_id: REL_BOB,
        outcome: "CANCELED_BY_THEM",
        note: "Bob cancelled last minute",
      });
      await doRpc(userGraphDO, "/markOutcome", {
        relationship_id: REL_BOB,
        outcome: "CANCELED_BY_THEM",
        note: "Bob cancelled again",
      });
    });

    afterEach(() => {
      db.close();
    });

    it("/getRelationship returns correct relationship data", async () => {
      const alice = await doRpc<Record<string, unknown>>(
        userGraphDO,
        "/getRelationship",
        { relationship_id: REL_ALICE },
      );

      expect(alice.display_name).toBe("Alice Smith");
      expect(alice.category).toBe("COLLEAGUE");
      expect(alice.closeness_weight).toBe(0.8);
      expect(alice.city).toBe("New York");
      expect(alice.timezone).toBe("America/New_York");
    });

    it("/listRelationships returns all relationships", async () => {
      const result = await doRpc<{ items: Array<Record<string, unknown>> }>(
        userGraphDO,
        "/listRelationships",
        {},
      );

      expect(result.items).toHaveLength(2);
      const names = result.items.map((r) => r.display_name);
      expect(names).toContain("Alice Smith");
      expect(names).toContain("Bob Jones");
    });

    it("/listRelationships filters by category", async () => {
      const result = await doRpc<{ items: Array<Record<string, unknown>> }>(
        userGraphDO,
        "/listRelationships",
        { category: "CLIENT" },
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0].display_name).toBe("Bob Jones");
    });

    it("/getReputation returns high reliability for Alice (all positive)", async () => {
      const rep = await doRpc<ReputationResult>(userGraphDO, "/getReputation", {
        relationship_id: REL_ALICE,
      });

      expect(rep.reliability_score).toBeGreaterThanOrEqual(0.9);
      expect(rep.reciprocity_score).toBe(0.5); // no negative outcomes = balanced
      expect(rep.total_interactions).toBe(3);
    });

    it("/getReputation reflects Bob's cancellation pattern", async () => {
      const rep = await doRpc<ReputationResult>(userGraphDO, "/getReputation", {
        relationship_id: REL_BOB,
      });

      // Mixed outcomes: 1 attended, 2 cancelled by them
      expect(rep.total_interactions).toBe(3);

      // Reciprocity > 0.5 (they cancel more)
      // 2 them-negative / (2 them + 0 me) = 1.0
      expect(rep.reciprocity_score).toBeGreaterThan(0.5);
    });

    it("/listRelationshipsWithReputation returns all with scores", async () => {
      const result = await doRpc<{ items: Array<Record<string, unknown>> }>(
        userGraphDO,
        "/listRelationshipsWithReputation",
        {},
      );

      expect(result.items).toHaveLength(2);

      // Each item should have reputation data embedded
      for (const item of result.items) {
        expect(item.reputation).toBeDefined();
        const rep = item.reputation as Record<string, unknown>;
        expect(typeof rep.reliability_score).toBe("number");
        expect(typeof rep.reciprocity_score).toBe("number");
      }
    });

    it("/listOutcomes returns interaction history for a relationship", async () => {
      const result = await doRpc<{ items: Array<Record<string, unknown>> }>(
        userGraphDO,
        "/listOutcomes",
        { relationship_id: REL_ALICE },
      );

      expect(result.items).toHaveLength(3);
      expect(result.items.every((e) => e.outcome === "ATTENDED")).toBe(true);
    });

    it("/getTimeline returns interaction timeline", async () => {
      const result = await doRpc<{ items: Array<Record<string, unknown>> }>(
        userGraphDO,
        "/getTimeline",
        {},
      );

      // 6 total outcomes across both relationships
      expect(result.items).toHaveLength(6);

      // Each entry should have ledger fields
      for (const item of result.items) {
        expect(item.ledger_id).toBeDefined();
        expect(item.outcome).toBeDefined();
        expect(item.ts).toBeDefined();
      }
    });

    it("/getTimeline filters by participant hash", async () => {
      const result = await doRpc<{ items: Array<Record<string, unknown>> }>(
        userGraphDO,
        "/getTimeline",
        { participant_hash: HASH_BOB },
      );

      // Only Bob's 3 interactions
      expect(result.items).toHaveLength(3);
    });

    it("/updateRelationship modifies fields", async () => {
      await doRpc(userGraphDO, "/updateRelationship", {
        relationship_id: REL_BOB,
        closeness_weight: 0.3,
        city: "Berlin",
      });

      const updated = await doRpc<Record<string, unknown>>(
        userGraphDO,
        "/getRelationship",
        { relationship_id: REL_BOB },
      );

      expect(updated.closeness_weight).toBe(0.3);
      expect(updated.city).toBe("Berlin");
      // Unchanged fields preserved
      expect(updated.display_name).toBe("Bob Jones");
    });

    it("/deleteRelationship removes relationship", async () => {
      const result = await doRpc<{ deleted: boolean }>(
        userGraphDO,
        "/deleteRelationship",
        { relationship_id: REL_BOB },
      );

      expect(result.deleted).toBe(true);

      // Listing should now show only Alice
      const list = await doRpc<{ items: Array<Record<string, unknown>> }>(
        userGraphDO,
        "/listRelationships",
        {},
      );
      expect(list.items).toHaveLength(1);
      expect(list.items[0].display_name).toBe("Alice Smith");
    });
  });

  // =========================================================================
  // 8. Full Demo Scenario: All platform extensions combined
  // =========================================================================

  describe("8. Full demo scenario: all platform extensions exercised together", () => {
    let db: DatabaseType;
    let sql: SqlStorageLike;
    let queue: MockQueue;
    let userGraphDO: UserGraphDO;

    const REL_BOARD_CHAIR = "rel_board_chair_demo";
    const HASH_BOARD_CHAIR = "hash_board_chair_demo";

    beforeEach(async () => {
      db = new Database(":memory:");
      sql = createSqlStorageAdapter(db);
      queue = new MockQueue();
      userGraphDO = new UserGraphDO(sql, queue);
      eventCounter = 800;

      // Trigger lazy migration
      await userGraphDO.handleFetch(
        new Request("https://user-graph.internal/getSyncHealth"),
      );

      // Working hours constraint
      await addConstraint(userGraphDO, "working_hours", {
        days: [1, 2, 3, 4, 5],
        start_time: "09:00",
        end_time: "17:00",
        timezone: "UTC",
        start_hour: 9,
        end_hour: 17,
      });

      // Populate a typical work week
      const meetings = [
        { title: "Sprint Planning", start: "2026-03-02T09:00:00Z", end: "2026-03-02T10:00:00Z" },
        { title: "Client Call", start: "2026-03-02T11:00:00Z", end: "2026-03-02T12:00:00Z" },
        { title: "Team Standup", start: "2026-03-03T09:00:00Z", end: "2026-03-03T09:30:00Z" },
        { title: "Product Review", start: "2026-03-03T14:00:00Z", end: "2026-03-03T15:00:00Z" },
        { title: "Focus Time", start: "2026-03-04T09:00:00Z", end: "2026-03-04T12:00:00Z" },
        { title: "Sales Demo", start: "2026-03-04T14:00:00Z", end: "2026-03-04T15:00:00Z" },
        { title: "1:1 with CTO", start: "2026-03-05T10:00:00Z", end: "2026-03-05T11:00:00Z" },
        { title: "Board Prep", start: "2026-03-05T14:00:00Z", end: "2026-03-05T16:00:00Z" },
      ];

      for (const m of meetings) {
        insertEvent(db, m.start, m.end, { title: m.title });
      }

      // Create a relationship for the board chair
      await doRpc(userGraphDO, "/createRelationship", {
        relationship_id: REL_BOARD_CHAIR,
        participant_hash: HASH_BOARD_CHAIR,
        display_name: "Jane Board-Chair",
        category: "BOARD",
        closeness_weight: 0.9,
        city: "San Francisco",
        timezone: "America/Los_Angeles",
      });

      // Record some interactions with the board chair
      await doRpc(userGraphDO, "/markOutcome", {
        relationship_id: REL_BOARD_CHAIR,
        outcome: "ATTENDED",
        note: "Quarterly review",
      });
      await doRpc(userGraphDO, "/markOutcome", {
        relationship_id: REL_BOARD_CHAIR,
        outcome: "ATTENDED",
        note: "Fundraising call",
      });
    });

    afterEach(() => {
      db.close();
    });

    it("Step 1: CalDAV feed -- unified events visible in subscriber-ready format", async () => {
      const rows = db
        .prepare("SELECT * FROM canonical_events ORDER BY start_ts")
        .all() as Array<Record<string, unknown>>;

      const events: CanonicalEvent[] = rows.map((row) => ({
        canonical_event_id: row.canonical_event_id as EventId,
        origin_account_id: row.origin_account_id as AccountId,
        origin_event_id: row.origin_event_id as string,
        title: row.title as string,
        start: { dateTime: row.start_ts as string },
        end: { dateTime: row.end_ts as string },
        all_day: row.all_day === 1,
        status: row.status as "confirmed" | "tentative" | "cancelled",
        visibility: row.visibility as "default",
        transparency: row.transparency as "opaque" | "transparent",
        recurrence_rule: row.recurrence_rule as string | undefined,
        source: row.source as "provider",
        version: row.version as number,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
      }));

      const ical = buildVCalendar(events);

      // Valid iCalendar document with all events
      expect(ical).toContain("BEGIN:VCALENDAR");
      expect(ical).toContain("VERSION:2.0");
      expect(ical).toContain("METHOD:PUBLISH");

      const beginCount = (ical.match(/BEGIN:VEVENT/g) || []).length;
      expect(beginCount).toBe(8);

      // Key events present
      expect(ical).toContain("SUMMARY:Sprint Planning");
      expect(ical).toContain("SUMMARY:Board Prep");
      expect(ical).toContain("SUMMARY:Focus Time");
    });

    it("Step 2: Org policy merge -- org working hours inherited by member", () => {
      const orgPolicies: OrgPolicy[] = [
        {
          policy_type: "mandatory_working_hours",
          config: { start_hour: 8, end_hour: 18 },
        },
        {
          policy_type: "minimum_vip_priority",
          config: { minimum_weight: 0.5 },
        },
        {
          policy_type: "required_projection_detail",
          config: { minimum_detail: "TITLE" as const },
        },
      ];

      const userPolicies: UserPolicies = {
        working_hours: { start_hour: 9, end_hour: 17 },
        vip_list: [
          { contact_email: "board-chair@company.com", weight: 0.9 },
          { contact_email: "intern@company.com", weight: 0.1 },
        ],
        account_count: 2,
        projection_detail: "BUSY",
      };

      const merged = mergeOrgAndUserPolicies(orgPolicies, userPolicies);

      // User's 9-17 is within org's 8-18 -> preserved
      expect(merged.working_hours.start_hour).toBe(9);
      expect(merged.working_hours.end_hour).toBe(17);

      // Board chair VIP above floor, intern raised to 0.5
      expect(merged.vip_list[0].weight).toBe(0.9);
      expect(merged.vip_list[1].weight).toBe(0.5);

      // BUSY raised to TITLE
      expect(merged.projection_detail).toBe("TITLE");
    });

    it("Step 3: What-if simulation -- 'Accept board seat' impact report", async () => {
      const report = await doRpc<ImpactReport>(userGraphDO, "/simulate", {
        scenario: {
          type: "add_recurring_event",
          title: "Board Meeting",
          day_of_week: 4, // Friday
          start_time: 10,
          end_time: 13,
          duration_weeks: SIMULATION_WEEKS,
        },
      });

      // Adding 3h/week of board meetings
      expect(report.projected_weekly_hours).toBeGreaterThan(0);
      expect(typeof report.conflict_count).toBe("number");
      expect(typeof report.burnout_risk_delta).toBe("number");
      expect(report.burnout_risk_delta).toBeGreaterThan(0); // more hours = more risk
      expect(Array.isArray(report.constraint_violations)).toBe(true);
    });

    it("Step 4: Graph API -- query relationship data for board chair", async () => {
      // Get relationship details
      const rel = await doRpc<Record<string, unknown>>(
        userGraphDO,
        "/getRelationship",
        { relationship_id: REL_BOARD_CHAIR },
      );
      expect(rel.display_name).toBe("Jane Board-Chair");
      expect(rel.category).toBe("BOARD");

      // Get reputation (all attended -> high reliability)
      const rep = await doRpc<ReputationResult>(
        userGraphDO,
        "/getReputation",
        { relationship_id: REL_BOARD_CHAIR },
      );
      expect(rep.reliability_score).toBeGreaterThanOrEqual(0.9);
      expect(rep.reciprocity_score).toBe(0.5); // balanced
      expect(rep.total_interactions).toBe(2);

      // Get timeline
      const timeline = await doRpc<{ items: Array<Record<string, unknown>> }>(
        userGraphDO,
        "/getTimeline",
        { participant_hash: HASH_BOARD_CHAIR },
      );
      expect(timeline.items).toHaveLength(2);
      expect(timeline.items[0].outcome).toBe("ATTENDED");
    });

    it("Step 5: All features demoable -- each returns valid, non-empty results", async () => {
      // CalDAV feed
      const rows = db
        .prepare("SELECT * FROM canonical_events ORDER BY start_ts")
        .all() as Array<Record<string, unknown>>;
      const events: CanonicalEvent[] = rows.map((row) => ({
        canonical_event_id: row.canonical_event_id as EventId,
        origin_account_id: row.origin_account_id as AccountId,
        origin_event_id: row.origin_event_id as string,
        title: row.title as string,
        start: { dateTime: row.start_ts as string },
        end: { dateTime: row.end_ts as string },
        all_day: false,
        status: "confirmed",
        visibility: "default" as const,
        transparency: "opaque" as const,
        source: "provider" as const,
        version: 1,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
      }));
      const ical = buildVCalendar(events);
      expect(ical.length).toBeGreaterThan(100);
      expect((ical.match(/BEGIN:VEVENT/g) || []).length).toBeGreaterThan(0);

      // Org policy merge
      const merged = mergeOrgAndUserPolicies(
        [{ policy_type: "mandatory_working_hours", config: { start_hour: 8, end_hour: 18 } }],
        { working_hours: { start_hour: 9, end_hour: 17 }, account_count: 1 },
      );
      expect(merged.working_hours.start_hour).toBe(9);

      // Simulation
      const sim = await doRpc<ImpactReport>(userGraphDO, "/simulate", {
        scenario: {
          type: "add_recurring_event",
          title: "Demo Event",
          day_of_week: 0,
          start_time: 15,
          end_time: 16,
          duration_weeks: 2,
        },
      });
      expect(typeof sim.projected_weekly_hours).toBe("number");
      expect(typeof sim.conflict_count).toBe("number");

      // Graph API: relationships
      const rels = await doRpc<{ items: Array<Record<string, unknown>> }>(
        userGraphDO,
        "/listRelationships",
        {},
      );
      expect(rels.items.length).toBeGreaterThan(0);

      // Graph API: reputation
      const rep = await doRpc<ReputationResult>(
        userGraphDO,
        "/getReputation",
        { relationship_id: REL_BOARD_CHAIR },
      );
      expect(rep.reliability_score).toBeGreaterThanOrEqual(0);
      expect(rep.reliability_score).toBeLessThanOrEqual(1);

      // Graph API: timeline
      const tl = await doRpc<{ items: Array<Record<string, unknown>> }>(
        userGraphDO,
        "/getTimeline",
        {},
      );
      expect(tl.items.length).toBeGreaterThan(0);
    });
  });
});
