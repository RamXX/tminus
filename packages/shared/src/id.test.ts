import { describe, it, expect } from "vitest";
import { generateId, parseId, isValidId, type EntityType } from "./id";
import { ID_PREFIXES } from "./constants";

// ---------------------------------------------------------------------------
// ULID format: 26 characters of Crockford's Base32
// Valid chars: 0123456789ABCDEFGHJKMNPQRSTVWXYZ
// ---------------------------------------------------------------------------
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("generateId", () => {
  it("produces a string with the correct prefix for each entity type", () => {
    const entityTypes = Object.keys(ID_PREFIXES) as EntityType[];
    for (const entity of entityTypes) {
      const id = generateId(entity);
      const prefix = ID_PREFIXES[entity];
      expect(id.startsWith(prefix)).toBe(true);
    }
  });

  it("produces a valid ULID after the prefix", () => {
    const id = generateId("user");
    const ulidPart = id.slice(ID_PREFIXES.user.length);
    expect(ulidPart).toMatch(ULID_REGEX);
  });

  it("produces IDs of correct total length (4-char prefix + 26-char ULID)", () => {
    const entityTypes = Object.keys(ID_PREFIXES) as EntityType[];
    for (const entity of entityTypes) {
      const id = generateId(entity);
      expect(id).toHaveLength(4 + 26);
    }
  });

  it("produces unique IDs on successive calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateId("event"));
    }
    expect(ids.size).toBe(100);
  });

  it("produces monotonically increasing ULIDs within rapid succession", () => {
    // ULIDs are lexicographically sortable by time; within the same ms the
    // random component is incremented, so successive IDs should still sort.
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      ids.push(generateId("user"));
    }
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("different entity types produce different prefixes", () => {
    const userId = generateId("user");
    const accountId = generateId("account");
    const eventId = generateId("event");
    const policyId = generateId("policy");
    const calendarId = generateId("calendar");
    const journalId = generateId("journal");
    const constraintId = generateId("constraint");

    expect(userId.slice(0, 4)).toBe("usr_");
    expect(accountId.slice(0, 4)).toBe("acc_");
    expect(eventId.slice(0, 4)).toBe("evt_");
    expect(policyId.slice(0, 4)).toBe("pol_");
    expect(calendarId.slice(0, 4)).toBe("cal_");
    expect(journalId.slice(0, 4)).toBe("jrn_");
    expect(constraintId.slice(0, 4)).toBe("cst_");
  });
});

describe("parseId", () => {
  it("extracts entity type and raw ULID from a valid ID", () => {
    const id = generateId("event");
    const parsed = parseId(id);
    expect(parsed).not.toBeNull();
    expect(parsed!.entity).toBe("event");
    expect(parsed!.ulid).toMatch(ULID_REGEX);
  });

  it("works for every entity type", () => {
    const entityTypes = Object.keys(ID_PREFIXES) as EntityType[];
    for (const entity of entityTypes) {
      const id = generateId(entity);
      const parsed = parseId(id);
      expect(parsed).not.toBeNull();
      expect(parsed!.entity).toBe(entity);
      expect(parsed!.ulid).toHaveLength(26);
    }
  });

  it("returns null for an empty string", () => {
    expect(parseId("")).toBeNull();
  });

  it("returns null for a string with no matching prefix", () => {
    expect(parseId("xxx_01HXYZ1234567890123456")).toBeNull();
  });

  it("returns null for a prefix-only string (no ULID)", () => {
    expect(parseId("usr_")).toBeNull();
  });

  it("returns null for a valid prefix with wrong-length ULID", () => {
    expect(parseId("usr_TOOSHORT")).toBeNull();
  });

  it("returns null for a valid prefix with invalid ULID characters", () => {
    // 'I', 'L', 'O', 'U' are not in Crockford's Base32
    expect(parseId("usr_IIIIIIIIIIIIIIIIIIIIIIIIII")).toBeNull();
  });

  it("round-trips with generateId", () => {
    const original = generateId("policy");
    const parsed = parseId(original);
    expect(parsed).not.toBeNull();
    expect(ID_PREFIXES[parsed!.entity] + parsed!.ulid).toBe(original);
  });
});

describe("isValidId", () => {
  it("accepts valid IDs without specifying entity type", () => {
    const entityTypes = Object.keys(ID_PREFIXES) as EntityType[];
    for (const entity of entityTypes) {
      const id = generateId(entity);
      expect(isValidId(id)).toBe(true);
    }
  });

  it("accepts valid IDs with correct expected entity type", () => {
    const id = generateId("user");
    expect(isValidId(id, "user")).toBe(true);
  });

  it("rejects valid IDs with wrong expected entity type", () => {
    const id = generateId("user");
    expect(isValidId(id, "event")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidId("")).toBe(false);
  });

  it("rejects random garbage", () => {
    expect(isValidId("not-a-real-id")).toBe(false);
  });

  it("rejects prefix with no ULID", () => {
    expect(isValidId("usr_")).toBe(false);
  });

  it("rejects unknown prefix", () => {
    expect(isValidId("zzz_01HXYZ12345678901234AB")).toBe(false);
  });

  it("rejects valid prefix with ULID of wrong length", () => {
    expect(isValidId("usr_01HXYZ")).toBe(false);
  });

  it("rejects valid prefix with ULID containing invalid chars", () => {
    expect(isValidId("usr_IIIIIIIIIIIIIIIIIIIIIIIIII")).toBe(false);
  });

  it("rejects null and undefined via type system (runtime guard)", () => {
    // TypeScript would prevent this, but runtime guard matters
    expect(isValidId(null as unknown as string)).toBe(false);
    expect(isValidId(undefined as unknown as string)).toBe(false);
  });
});
