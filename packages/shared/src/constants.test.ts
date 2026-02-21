import { describe, it, expect } from "vitest";
import {
  EXTENDED_PROP_TMINUS,
  EXTENDED_PROP_MANAGED,
  EXTENDED_PROP_CANONICAL_ID,
  EXTENDED_PROP_ORIGIN_ACCOUNT,
  TMINUS_MANAGED_CATEGORY,
  BUSY_OVERLAY_CALENDAR_NAME,
  DEFAULT_DETAIL_LEVEL,
  DEFAULT_CALENDAR_KIND,
  ID_PREFIXES,
  RELATIONSHIP_CATEGORIES,
  isValidRelationshipCategory,
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

describe("constants.ts -- Microsoft managed-mirror marker", () => {
  it("TMINUS_MANAGED_CATEGORY is 'T-Minus Managed'", () => {
    expect(TMINUS_MANAGED_CATEGORY).toBe("T-Minus Managed");
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
  it("contains all expected entity prefixes", () => {
    const keys = Object.keys(ID_PREFIXES);
    // Every entity type in ID_PREFIXES must be listed here.
    // When you add a new entity type to ID_PREFIXES, add it here too.
    const requiredKeys = [
      "user", "account", "event", "policy", "calendar",
      "journal", "constraint", "apikey", "cert",
      "session", "candidate", "hold", "vip", "allocation",
      "commitment", "report", "relationship", "ledger",
      "alert", "milestone", "proof", "schedHist",
      "org", "onboardSession", "orgInstall", "delegation",
      "audit", "cache", "discovery",
    ];
    for (const key of requiredKeys) {
      expect(keys).toContain(key);
    }
    // Exact count ensures both additions and removals are caught
    expect(keys.length).toBe(requiredKeys.length);
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

  it("session prefix is 'ses_'", () => {
    expect(ID_PREFIXES.session).toBe("ses_");
  });

  it("candidate prefix is 'cnd_'", () => {
    expect(ID_PREFIXES.candidate).toBe("cnd_");
  });

  it("hold prefix is 'hld_'", () => {
    expect(ID_PREFIXES.hold).toBe("hld_");
  });

  it("vip prefix is 'vip_'", () => {
    expect(ID_PREFIXES.vip).toBe("vip_");
  });

  it("allocation prefix is 'alc_'", () => {
    expect(ID_PREFIXES.allocation).toBe("alc_");
  });

  it("commitment prefix is 'cmt_'", () => {
    expect(ID_PREFIXES.commitment).toBe("cmt_");
  });

  it("report prefix is 'rpt_'", () => {
    expect(ID_PREFIXES.report).toBe("rpt_");
  });

  it("ledger prefix is 'ldg_'", () => {
    expect(ID_PREFIXES.ledger).toBe("ldg_");
  });

  it("alert prefix is 'alt_'", () => {
    expect(ID_PREFIXES.alert).toBe("alt_");
  });

  it("milestone prefix is 'mst_'", () => {
    expect(ID_PREFIXES.milestone).toBe("mst_");
  });

  it("proof prefix is 'prf_'", () => {
    expect(ID_PREFIXES.proof).toBe("prf_");
  });

  it("schedHist prefix is 'shx_'", () => {
    expect(ID_PREFIXES.schedHist).toBe("shx_");
  });

  it("org prefix is 'org_'", () => {
    expect(ID_PREFIXES.org).toBe("org_");
  });

  it("onboardSession prefix is 'obs_'", () => {
    expect(ID_PREFIXES.onboardSession).toBe("obs_");
  });

  it("orgInstall prefix is 'oin_'", () => {
    expect(ID_PREFIXES.orgInstall).toBe("oin_");
  });

  it("audit prefix is 'aud_'", () => {
    expect(ID_PREFIXES.audit).toBe("aud_");
  });

  it("cache prefix is 'cch_'", () => {
    expect(ID_PREFIXES.cache).toBe("cch_");
  });

  it("discovery prefix is 'dsc_'", () => {
    expect(ID_PREFIXES.discovery).toBe("dsc_");
  });

  it("all prefixes end with underscore", () => {
    for (const [, prefix] of Object.entries(ID_PREFIXES)) {
      expect(prefix).toMatch(/_$/);
    }
  });

  it("relationship prefix is 'rel_'", () => {
    expect(ID_PREFIXES.relationship).toBe("rel_");
  });

  it("delegation prefix is 'dlg_'", () => {
    expect(ID_PREFIXES.delegation).toBe("dlg_");
  });

  it("all prefixes are exactly 4 characters", () => {
    for (const [, prefix] of Object.entries(ID_PREFIXES)) {
      expect(prefix).toHaveLength(4);
    }
  });
});

describe("constants.ts -- RELATIONSHIP_CATEGORIES", () => {
  it("contains all expected categories", () => {
    expect(RELATIONSHIP_CATEGORIES).toEqual([
      "FAMILY",
      "INVESTOR",
      "FRIEND",
      "CLIENT",
      "BOARD",
      "COLLEAGUE",
      "OTHER",
    ]);
  });

  it("isValidRelationshipCategory accepts valid categories", () => {
    for (const cat of RELATIONSHIP_CATEGORIES) {
      expect(isValidRelationshipCategory(cat)).toBe(true);
    }
  });

  it("isValidRelationshipCategory rejects invalid categories", () => {
    expect(isValidRelationshipCategory("INVALID")).toBe(false);
    expect(isValidRelationshipCategory("")).toBe(false);
    expect(isValidRelationshipCategory("friend")).toBe(false);
  });
});
