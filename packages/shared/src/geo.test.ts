import { describe, it, expect } from "vitest";
import {
  resolveCity,
  matchCityWithAliases,
  cityToTimezone,
  computeWorkingHoursOverlap,
  suggestMeetingWindow,
  CITY_ALIASES,
  CITY_TIMEZONES,
} from "./geo";

// ---------------------------------------------------------------------------
// resolveCity -- alias resolution
// ---------------------------------------------------------------------------

describe("resolveCity", () => {
  it("resolves NYC to New York", () => {
    expect(resolveCity("NYC")).toBe("New York");
  });

  it("resolves nyc (lowercase) to New York", () => {
    expect(resolveCity("nyc")).toBe("New York");
  });

  it("resolves Manhattan to New York", () => {
    expect(resolveCity("Manhattan")).toBe("New York");
  });

  it("resolves The Big Apple to New York", () => {
    expect(resolveCity("The Big Apple")).toBe("New York");
  });

  it("resolves SF to San Francisco", () => {
    expect(resolveCity("SF")).toBe("San Francisco");
  });

  it("resolves Frisco to San Francisco", () => {
    expect(resolveCity("Frisco")).toBe("San Francisco");
  });

  it("resolves LA to Los Angeles", () => {
    expect(resolveCity("LA")).toBe("Los Angeles");
  });

  it("resolves DC to Washington, D.C.", () => {
    expect(resolveCity("DC")).toBe("Washington, D.C.");
  });

  it("resolves Washington DC to Washington, D.C.", () => {
    expect(resolveCity("Washington DC")).toBe("Washington, D.C.");
  });

  it("resolves Philly to Philadelphia", () => {
    expect(resolveCity("Philly")).toBe("Philadelphia");
  });

  it("resolves CDMX to Mexico City", () => {
    expect(resolveCity("CDMX")).toBe("Mexico City");
  });

  it("resolves Ciudad de Mexico to Mexico City", () => {
    expect(resolveCity("Ciudad de Mexico")).toBe("Mexico City");
  });

  it("resolves Muenchen to Munich", () => {
    expect(resolveCity("Muenchen")).toBe("Munich");
  });

  it("resolves Koeln to Cologne", () => {
    expect(resolveCity("Koeln")).toBe("Cologne");
  });

  it("resolves Firenze to Florence", () => {
    expect(resolveCity("Firenze")).toBe("Florence");
  });

  it("resolves Praha to Prague", () => {
    expect(resolveCity("Praha")).toBe("Prague");
  });

  it("resolves Sankt-Peterburg to Saint Petersburg", () => {
    expect(resolveCity("Sankt-Peterburg")).toBe("Saint Petersburg");
  });

  it("resolves Bombay to Mumbai", () => {
    expect(resolveCity("Bombay")).toBe("Mumbai");
  });

  it("resolves Peking to Beijing", () => {
    expect(resolveCity("Peking")).toBe("Beijing");
  });

  it("resolves Canton to Guangzhou", () => {
    expect(resolveCity("Canton")).toBe("Guangzhou");
  });

  it("returns canonical name unchanged when already canonical", () => {
    expect(resolveCity("Berlin")).toBe("Berlin");
    expect(resolveCity("London")).toBe("London");
    expect(resolveCity("Tokyo")).toBe("Tokyo");
  });

  it("falls back to trimmed input for unknown cities", () => {
    expect(resolveCity("Smallville")).toBe("Smallville");
    expect(resolveCity("  Unknown City  ")).toBe("Unknown City");
  });

  it("handles null/undefined/empty gracefully", () => {
    expect(resolveCity(null)).toBeNull();
    expect(resolveCity(undefined)).toBeNull();
    expect(resolveCity("")).toBeNull();
    expect(resolveCity("   ")).toBeNull();
  });

  it("is case-insensitive for alias lookup", () => {
    expect(resolveCity("nyc")).toBe("New York");
    expect(resolveCity("NYC")).toBe("New York");
    expect(resolveCity("Nyc")).toBe("New York");
  });

  it("trims whitespace before resolving", () => {
    expect(resolveCity("  NYC  ")).toBe("New York");
    expect(resolveCity("  Berlin  ")).toBe("Berlin");
  });
});

// ---------------------------------------------------------------------------
// matchCityWithAliases -- enhanced city matching
// ---------------------------------------------------------------------------

describe("matchCityWithAliases", () => {
  it("matches NYC with New York via alias resolution", () => {
    expect(matchCityWithAliases("NYC", "New York")).toBe(true);
  });

  it("matches New York with NYC via alias resolution", () => {
    expect(matchCityWithAliases("New York", "NYC")).toBe(true);
  });

  it("matches Manhattan with NYC (both resolve to New York)", () => {
    expect(matchCityWithAliases("Manhattan", "NYC")).toBe(true);
  });

  it("matches SF with San Francisco", () => {
    expect(matchCityWithAliases("SF", "San Francisco")).toBe(true);
  });

  it("matches Bombay with Mumbai", () => {
    expect(matchCityWithAliases("Bombay", "Mumbai")).toBe(true);
  });

  it("matches same city case-insensitively (backward compatible)", () => {
    expect(matchCityWithAliases("Berlin", "berlin")).toBe(true);
    expect(matchCityWithAliases("berlin", "BERLIN")).toBe(true);
  });

  it("rejects different cities", () => {
    expect(matchCityWithAliases("Berlin", "Munich")).toBe(false);
    expect(matchCityWithAliases("NYC", "Los Angeles")).toBe(false);
  });

  it("handles null/empty inputs", () => {
    expect(matchCityWithAliases(null, "Berlin")).toBe(false);
    expect(matchCityWithAliases("Berlin", null)).toBe(false);
    expect(matchCityWithAliases("", "Berlin")).toBe(false);
    expect(matchCityWithAliases(null, null)).toBe(false);
  });

  it("falls back to exact match for unknown cities", () => {
    expect(matchCityWithAliases("Smallville", "Smallville")).toBe(true);
    expect(matchCityWithAliases("Smallville", "Bigtown")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CITY_ALIASES -- coverage
// ---------------------------------------------------------------------------

describe("CITY_ALIASES", () => {
  it("covers 100+ major cities", () => {
    // Count unique canonical city names
    const canonicalCities = new Set(Object.values(CITY_ALIASES));
    expect(canonicalCities.size).toBeGreaterThanOrEqual(100);
  });

  it("has all keys in lowercase for consistent lookup", () => {
    for (const key of Object.keys(CITY_ALIASES)) {
      expect(key).toBe(key.toLowerCase());
    }
  });

  it("includes major US cities", () => {
    const values = new Set(Object.values(CITY_ALIASES));
    expect(values.has("New York")).toBe(true);
    expect(values.has("Los Angeles")).toBe(true);
    expect(values.has("Chicago")).toBe(true);
    expect(values.has("San Francisco")).toBe(true);
    expect(values.has("Boston")).toBe(true);
    expect(values.has("Seattle")).toBe(true);
    expect(values.has("Miami")).toBe(true);
  });

  it("includes major European cities", () => {
    const values = new Set(Object.values(CITY_ALIASES));
    expect(values.has("London")).toBe(true);
    expect(values.has("Paris")).toBe(true);
    expect(values.has("Berlin")).toBe(true);
    expect(values.has("Munich")).toBe(true);
    expect(values.has("Amsterdam")).toBe(true);
    expect(values.has("Zurich")).toBe(true);
    expect(values.has("Barcelona")).toBe(true);
  });

  it("includes major Asian cities", () => {
    const values = new Set(Object.values(CITY_ALIASES));
    expect(values.has("Tokyo")).toBe(true);
    expect(values.has("Singapore")).toBe(true);
    expect(values.has("Beijing")).toBe(true);
    expect(values.has("Mumbai")).toBe(true);
    expect(values.has("Seoul")).toBe(true);
    expect(values.has("Hong Kong")).toBe(true);
    expect(values.has("Shanghai")).toBe(true);
  });

  it("has extensible format (plain object, easy to add entries)", () => {
    // Verify it's a plain Record<string, string>
    expect(typeof CITY_ALIASES).toBe("object");
    expect(CITY_ALIASES).not.toBeNull();
    // Every value should be a non-empty string
    for (const [key, value] of Object.entries(CITY_ALIASES)) {
      expect(typeof key).toBe("string");
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// cityToTimezone -- timezone lookup
// ---------------------------------------------------------------------------

describe("cityToTimezone", () => {
  it("returns America/New_York for New York", () => {
    expect(cityToTimezone("New York")).toBe("America/New_York");
  });

  it("returns America/New_York for NYC (via alias resolution)", () => {
    expect(cityToTimezone("NYC")).toBe("America/New_York");
  });

  it("returns Europe/Berlin for Berlin", () => {
    expect(cityToTimezone("Berlin")).toBe("Europe/Berlin");
  });

  it("returns Europe/Berlin for Munich", () => {
    expect(cityToTimezone("Europe/Berlin")).toBeNull(); // Not a city name
    expect(cityToTimezone("Munich")).toBe("Europe/Berlin");
  });

  it("returns Asia/Tokyo for Tokyo", () => {
    expect(cityToTimezone("Tokyo")).toBe("Asia/Tokyo");
  });

  it("returns Europe/London for London", () => {
    expect(cityToTimezone("London")).toBe("Europe/London");
  });

  it("returns America/Los_Angeles for SF", () => {
    expect(cityToTimezone("SF")).toBe("America/Los_Angeles");
  });

  it("returns America/Los_Angeles for LA", () => {
    expect(cityToTimezone("LA")).toBe("America/Los_Angeles");
  });

  it("returns null for unknown cities", () => {
    expect(cityToTimezone("Smallville")).toBeNull();
  });

  it("returns null for null/empty input", () => {
    expect(cityToTimezone(null)).toBeNull();
    expect(cityToTimezone("")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(cityToTimezone("new york")).toBe("America/New_York");
    expect(cityToTimezone("BERLIN")).toBe("Europe/Berlin");
  });
});

// ---------------------------------------------------------------------------
// CITY_TIMEZONES -- coverage
// ---------------------------------------------------------------------------

describe("CITY_TIMEZONES", () => {
  it("has IANA timezone identifiers as values", () => {
    // IANA timezones follow Area/Location pattern
    // IANA timezones follow Area/Location or Area/Sub/Location pattern
    const ianaPattern = /^[A-Za-z]+\/[A-Za-z_]+(\/[A-Za-z_]+)?$/;
    for (const [, tz] of Object.entries(CITY_TIMEZONES)) {
      expect(tz).toMatch(ianaPattern);
    }
  });

  it("covers all cities that have aliases", () => {
    // Every canonical city in the alias table should have a timezone
    const canonicalCities = new Set(Object.values(CITY_ALIASES));
    for (const city of canonicalCities) {
      const key = city.toLowerCase();
      expect(
        CITY_TIMEZONES[key],
        `Missing timezone for canonical city: ${city}`,
      ).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// computeWorkingHoursOverlap
// ---------------------------------------------------------------------------

describe("computeWorkingHoursOverlap", () => {
  it("returns full overlap for same timezone", () => {
    const overlap = computeWorkingHoursOverlap(
      "America/New_York",
      "America/New_York",
      "2026-03-15", // A regular day, no DST transition
    );
    expect(overlap).not.toBeNull();
    // Same timezone: overlap is the full working day 9-17
    expect(overlap!.startHourUTC).toBeDefined();
    expect(overlap!.endHourUTC).toBeDefined();
    expect(overlap!.overlapHours).toBe(8);
  });

  it("computes overlap between New York (UTC-5) and London (UTC+0)", () => {
    const overlap = computeWorkingHoursOverlap(
      "America/New_York",
      "Europe/London",
      "2026-03-15", // Before US DST spring forward (March 8), before UK DST (March 29)
      // NY is UTC-5, London is UTC+0
      // NY working: 14:00-22:00 UTC
      // London working: 09:00-17:00 UTC
      // Overlap: 14:00-17:00 UTC = 3 hours
    );
    expect(overlap).not.toBeNull();
    expect(overlap!.overlapHours).toBeGreaterThanOrEqual(3);
    expect(overlap!.overlapHours).toBeLessThanOrEqual(5);
  });

  it("computes overlap between New York (UTC-5) and Tokyo (UTC+9)", () => {
    // NY working: 14:00-22:00 UTC
    // Tokyo working: 00:00-08:00 UTC
    // No overlap (or very minimal)
    const overlap = computeWorkingHoursOverlap(
      "America/New_York",
      "Asia/Tokyo",
      "2026-01-15", // Winter, no DST complications
    );
    // Could be null or have 0 hours overlap
    if (overlap) {
      expect(overlap.overlapHours).toBeLessThanOrEqual(1);
    }
  });

  it("computes overlap between London (UTC+0) and Berlin (UTC+1)", () => {
    // London working: 09:00-17:00 UTC
    // Berlin working: 08:00-16:00 UTC
    // Overlap: 09:00-16:00 UTC = 7 hours
    const overlap = computeWorkingHoursOverlap(
      "Europe/London",
      "Europe/Berlin",
      "2026-01-15",
    );
    expect(overlap).not.toBeNull();
    expect(overlap!.overlapHours).toBe(7);
  });

  it("returns null when either timezone is null", () => {
    expect(computeWorkingHoursOverlap(null, "Europe/London", "2026-01-15")).toBeNull();
    expect(computeWorkingHoursOverlap("Europe/London", null, "2026-01-15")).toBeNull();
  });

  it("returns null when either timezone is invalid/unknown", () => {
    expect(
      computeWorkingHoursOverlap("Invalid/Timezone", "Europe/London", "2026-01-15"),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// suggestMeetingWindow
// ---------------------------------------------------------------------------

describe("suggestMeetingWindow", () => {
  it("suggests time within trip window and working hours overlap", () => {
    const window = suggestMeetingWindow(
      "2026-04-01T00:00:00Z", // trip start
      "2026-04-05T00:00:00Z", // trip end
      "America/New_York",     // user's timezone (traveler)
      "America/New_York",     // contact's timezone
      60,                     // duration minutes
    );
    expect(window).not.toBeNull();
    // Should be within trip dates
    expect(window!.earliest >= "2026-04-01T00:00:00Z").toBe(true);
    expect(window!.latest <= "2026-04-05T23:59:59Z").toBe(true);
    // Working hours info should be present
    expect(window!.suggested_start_hour_utc).toBeDefined();
    expect(window!.suggested_end_hour_utc).toBeDefined();
  });

  it("narrows time window based on working hours overlap", () => {
    // NY traveler meeting a London contact
    const window = suggestMeetingWindow(
      "2026-04-01T00:00:00Z",
      "2026-04-05T00:00:00Z",
      "America/New_York",
      "Europe/London",
      60,
    );
    expect(window).not.toBeNull();
    // The suggested hours should reflect overlap, not the full trip window
    expect(window!.suggested_start_hour_utc).toBeDefined();
    expect(window!.suggested_end_hour_utc).toBeDefined();
    // Overlap is afternoon UTC (when both are working)
    expect(window!.suggested_start_hour_utc).toBeGreaterThanOrEqual(9);
  });

  it("returns basic trip window when no timezone info available", () => {
    const window = suggestMeetingWindow(
      "2026-04-01T00:00:00Z",
      "2026-04-05T00:00:00Z",
      null,
      null,
      60,
    );
    expect(window).not.toBeNull();
    expect(window!.earliest).toBe("2026-04-01T00:00:00Z");
    expect(window!.latest).toBe("2026-04-05T00:00:00Z");
    // No hour suggestions when timezone unknown
    expect(window!.suggested_start_hour_utc).toBeNull();
    expect(window!.suggested_end_hour_utc).toBeNull();
  });

  it("returns null when no trip dates provided", () => {
    const window = suggestMeetingWindow(null, null, "America/New_York", "Europe/London", 60);
    expect(window).toBeNull();
  });

  it("includes timezone info for both parties in the window", () => {
    const window = suggestMeetingWindow(
      "2026-04-01T00:00:00Z",
      "2026-04-05T00:00:00Z",
      "America/New_York",
      "Europe/Berlin",
      45,
    );
    expect(window).not.toBeNull();
    expect(window!.user_timezone).toBe("America/New_York");
    expect(window!.contact_timezone).toBe("Europe/Berlin");
  });
});
