/**
 * Unit tests for account scope management validation and capability mapping.
 *
 * Tests cover:
 * - deriveCapabilities: maps calendar_role to access_level + capabilities
 * - validateScopeUpdate: request body validation
 * - validateScopeCapabilities: prevents enabling sync on read-only calendars
 */

import { describe, it, expect } from "vitest";
import {
  deriveCapabilities,
  validateScopeUpdate,
  validateScopeCapabilities,
} from "./accounts";

// ---------------------------------------------------------------------------
// deriveCapabilities
// ---------------------------------------------------------------------------

describe("deriveCapabilities", () => {
  it("maps 'owner' to owner access with read+write", () => {
    const result = deriveCapabilities("owner");
    expect(result.access_level).toBe("owner");
    expect(result.capabilities).toEqual(["read", "write"]);
  });

  it("maps 'primary' to owner access (backward compat)", () => {
    const result = deriveCapabilities("primary");
    expect(result.access_level).toBe("owner");
    expect(result.capabilities).toEqual(["read", "write"]);
  });

  it("maps 'editor' to editor access with read+write", () => {
    const result = deriveCapabilities("editor");
    expect(result.access_level).toBe("editor");
    expect(result.capabilities).toEqual(["read", "write"]);
  });

  it("maps 'secondary' to editor access (backward compat)", () => {
    const result = deriveCapabilities("secondary");
    expect(result.access_level).toBe("editor");
    expect(result.capabilities).toEqual(["read", "write"]);
  });

  it("maps 'writer' to editor access", () => {
    const result = deriveCapabilities("writer");
    expect(result.access_level).toBe("editor");
    expect(result.capabilities).toEqual(["read", "write"]);
  });

  it("maps 'reader' to readonly access with read only", () => {
    const result = deriveCapabilities("reader");
    expect(result.access_level).toBe("readonly");
    expect(result.capabilities).toEqual(["read"]);
  });

  it("maps 'readonly' to readonly access with read only", () => {
    const result = deriveCapabilities("readonly");
    expect(result.access_level).toBe("readonly");
    expect(result.capabilities).toEqual(["read"]);
  });

  it("maps 'freeBusyReader' to freeBusyReader access with read only", () => {
    const result = deriveCapabilities("freeBusyReader");
    expect(result.access_level).toBe("freeBusyReader");
    expect(result.capabilities).toEqual(["read"]);
  });

  it("maps unknown role to readonly by default", () => {
    const result = deriveCapabilities("some_unknown_role");
    expect(result.access_level).toBe("readonly");
    expect(result.capabilities).toEqual(["read"]);
  });
});

// ---------------------------------------------------------------------------
// validateScopeUpdate
// ---------------------------------------------------------------------------

describe("validateScopeUpdate", () => {
  it("accepts valid scope update with all fields", () => {
    const result = validateScopeUpdate({
      scopes: [
        { provider_calendar_id: "primary", enabled: true, sync_enabled: false },
        { provider_calendar_id: "other-cal", enabled: false },
      ],
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.scopes).toHaveLength(2);
      expect(result.scopes[0].provider_calendar_id).toBe("primary");
      expect(result.scopes[0].enabled).toBe(true);
      expect(result.scopes[0].sync_enabled).toBe(false);
      expect(result.scopes[1].enabled).toBe(false);
      expect(result.scopes[1].sync_enabled).toBeUndefined();
    }
  });

  it("accepts minimal scope update (only provider_calendar_id)", () => {
    const result = validateScopeUpdate({
      scopes: [{ provider_calendar_id: "cal-123" }],
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.scopes).toHaveLength(1);
      expect(result.scopes[0].enabled).toBeUndefined();
    }
  });

  it("rejects null body", () => {
    const result = validateScopeUpdate(null);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("Request body must be a JSON object");
    }
  });

  it("rejects missing scopes array", () => {
    const result = validateScopeUpdate({});
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("scopes must be an array");
    }
  });

  it("rejects empty scopes array", () => {
    const result = validateScopeUpdate({ scopes: [] });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("scopes array must not be empty");
    }
  });

  it("rejects scope with missing provider_calendar_id", () => {
    const result = validateScopeUpdate({
      scopes: [{ enabled: true }],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("scopes[0].provider_calendar_id");
    }
  });

  it("rejects scope with empty provider_calendar_id", () => {
    const result = validateScopeUpdate({
      scopes: [{ provider_calendar_id: "" }],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("scopes[0].provider_calendar_id");
    }
  });

  it("rejects scope with non-boolean enabled", () => {
    const result = validateScopeUpdate({
      scopes: [{ provider_calendar_id: "cal", enabled: "yes" }],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("scopes[0].enabled must be a boolean");
    }
  });

  it("rejects scope with non-boolean sync_enabled", () => {
    const result = validateScopeUpdate({
      scopes: [{ provider_calendar_id: "cal", sync_enabled: 1 }],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("scopes[0].sync_enabled must be a boolean");
    }
  });

  it("rejects non-object scope items", () => {
    const result = validateScopeUpdate({
      scopes: ["not-an-object"],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("scopes[0] must be an object");
    }
  });
});

// ---------------------------------------------------------------------------
// validateScopeCapabilities
// ---------------------------------------------------------------------------

describe("validateScopeCapabilities", () => {
  it("allows enabling sync on a writable calendar", () => {
    const result = validateScopeCapabilities(
      [{ provider_calendar_id: "cal-1", sync_enabled: true }],
      [{ provider_calendar_id: "cal-1", calendar_role: "owner" }],
    );
    expect(result.valid).toBe(true);
  });

  it("allows enabling sync on an editor calendar", () => {
    const result = validateScopeCapabilities(
      [{ provider_calendar_id: "cal-1", sync_enabled: true }],
      [{ provider_calendar_id: "cal-1", calendar_role: "editor" }],
    );
    expect(result.valid).toBe(true);
  });

  it("rejects enabling sync on a readonly calendar", () => {
    const result = validateScopeCapabilities(
      [{ provider_calendar_id: "shared-cal", sync_enabled: true }],
      [{ provider_calendar_id: "shared-cal", calendar_role: "reader" }],
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("shared-cal");
      expect(result.error).toContain("write capability");
    }
  });

  it("rejects enabling sync on a freeBusyReader calendar", () => {
    const result = validateScopeCapabilities(
      [{ provider_calendar_id: "busy-cal", sync_enabled: true }],
      [{ provider_calendar_id: "busy-cal", calendar_role: "freeBusyReader" }],
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("busy-cal");
    }
  });

  it("allows disabling sync on any calendar", () => {
    const result = validateScopeCapabilities(
      [{ provider_calendar_id: "shared-cal", sync_enabled: false }],
      [{ provider_calendar_id: "shared-cal", calendar_role: "reader" }],
    );
    expect(result.valid).toBe(true);
  });

  it("allows new calendars not yet in existing scopes", () => {
    const result = validateScopeCapabilities(
      [{ provider_calendar_id: "new-cal", sync_enabled: true }],
      [],
    );
    expect(result.valid).toBe(true);
  });

  it("validates multiple scopes in a single call", () => {
    const result = validateScopeCapabilities(
      [
        { provider_calendar_id: "cal-owner", sync_enabled: true },
        { provider_calendar_id: "cal-reader", sync_enabled: true },
      ],
      [
        { provider_calendar_id: "cal-owner", calendar_role: "owner" },
        { provider_calendar_id: "cal-reader", calendar_role: "reader" },
      ],
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("cal-reader");
    }
  });

  it("allows updates that only toggle enabled, not sync_enabled", () => {
    const result = validateScopeCapabilities(
      [{ provider_calendar_id: "reader-cal", enabled: true }],
      [{ provider_calendar_id: "reader-cal", calendar_role: "reader" }],
    );
    expect(result.valid).toBe(true);
  });
});
