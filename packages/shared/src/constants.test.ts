import { describe, it, expect } from "vitest";
import {
  EXTENDED_PROP_TMINUS,
  EXTENDED_PROP_MANAGED,
  EXTENDED_PROP_CANONICAL_ID,
  EXTENDED_PROP_ORIGIN_ACCOUNT,
  BUSY_OVERLAY_CALENDAR_NAME,
  DEFAULT_DETAIL_LEVEL,
  DEFAULT_CALENDAR_KIND,
  ID_PREFIXES,
} from "./constants";

describe("constants.ts -- extended property keys", () => {
  it("EXTENDED_PROP_TMINUS is 'tminus'", () => {
    expect(EXTENDED_PROP_TMINUS).toBe("tminus");
  });

  it("EXTENDED_PROP_MANAGED is 'managed'", () => {
    expect(EXTENDED_PROP_MANAGED).toBe("managed");
  });

  it("EXTENDED_PROP_CANONICAL_ID is 'canonical_event_id'", () => {
    expect(EXTENDED_PROP_CANONICAL_ID).toBe("canonical_event_id");
  });

  it("EXTENDED_PROP_ORIGIN_ACCOUNT is 'origin_account_id'", () => {
    expect(EXTENDED_PROP_ORIGIN_ACCOUNT).toBe("origin_account_id");
  });
});

describe("constants.ts -- calendar defaults", () => {
  it("BUSY_OVERLAY_CALENDAR_NAME matches expected display name", () => {
    expect(BUSY_OVERLAY_CALENDAR_NAME).toBe("External Busy (T-Minus)");
  });

  it("DEFAULT_DETAIL_LEVEL is BUSY", () => {
    expect(DEFAULT_DETAIL_LEVEL).toBe("BUSY");
  });

  it("DEFAULT_CALENDAR_KIND is BUSY_OVERLAY", () => {
    expect(DEFAULT_CALENDAR_KIND).toBe("BUSY_OVERLAY");
  });
});

describe("constants.ts -- ID_PREFIXES", () => {
  it("contains all nine entity prefixes", () => {
    const expectedKeys = [
      "user",
      "account",
      "event",
      "policy",
      "calendar",
      "journal",
      "constraint",
      "apikey",
      "cert",
    ];
    expect(Object.keys(ID_PREFIXES).sort()).toEqual(expectedKeys.sort());
  });

  it("user prefix is 'usr_'", () => {
    expect(ID_PREFIXES.user).toBe("usr_");
  });

  it("account prefix is 'acc_'", () => {
    expect(ID_PREFIXES.account).toBe("acc_");
  });

  it("event prefix is 'evt_'", () => {
    expect(ID_PREFIXES.event).toBe("evt_");
  });

  it("policy prefix is 'pol_'", () => {
    expect(ID_PREFIXES.policy).toBe("pol_");
  });

  it("calendar prefix is 'cal_'", () => {
    expect(ID_PREFIXES.calendar).toBe("cal_");
  });

  it("journal prefix is 'jrn_'", () => {
    expect(ID_PREFIXES.journal).toBe("jrn_");
  });

  it("constraint prefix is 'cst_'", () => {
    expect(ID_PREFIXES.constraint).toBe("cst_");
  });

  it("apikey prefix is 'key_'", () => {
    expect(ID_PREFIXES.apikey).toBe("key_");
  });

  it("cert prefix is 'crt_'", () => {
    expect(ID_PREFIXES.cert).toBe("crt_");
  });

  it("all prefixes end with underscore", () => {
    for (const [, prefix] of Object.entries(ID_PREFIXES)) {
      expect(prefix).toMatch(/_$/);
    }
  });

  it("all prefixes are exactly 4 characters", () => {
    for (const [, prefix] of Object.entries(ID_PREFIXES)) {
      expect(prefix).toHaveLength(4);
    }
  });
});
