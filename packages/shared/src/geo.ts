/**
 * @tminus/shared -- Geo-matching engine for reconnection suggestions.
 *
 * Provides city alias resolution (NYC -> New York), timezone lookup,
 * and working-hours-aware meeting time suggestions. Designed to enhance
 * the reconnection pipeline from TM-xwn.1 with geo intelligence.
 *
 * All data is stored as plain JS objects for extensibility.
 * Distance-based matching (embeddings) is deferred to Phase 5.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Working hours overlap between two timezones. */
export interface WorkingHoursOverlap {
  /** Start of overlap window in UTC hours (0-23). */
  readonly startHourUTC: number;
  /** End of overlap window in UTC hours (0-23). */
  readonly endHourUTC: number;
  /** Number of overlapping working hours. */
  readonly overlapHours: number;
}

/** A timezone-aware meeting time suggestion. */
export interface TimezoneAwareMeetingWindow {
  /** Earliest possible meeting time (ISO 8601), bounded by trip start. */
  readonly earliest: string;
  /** Latest possible meeting time (ISO 8601), bounded by trip end. */
  readonly latest: string;
  /** Suggested meeting start hour in UTC (null if timezone unknown). */
  readonly suggested_start_hour_utc: number | null;
  /** Suggested meeting end hour in UTC (null if timezone unknown). */
  readonly suggested_end_hour_utc: number | null;
  /** User's (traveler's) timezone. */
  readonly user_timezone: string | null;
  /** Contact's timezone. */
  readonly contact_timezone: string | null;
}

// ---------------------------------------------------------------------------
// City Alias Table (~100+ major cities)
//
// Keys are lowercase for consistent lookup. Values are canonical city names.
// Format: alias -> canonical name. Canonical names also map to themselves.
// ---------------------------------------------------------------------------

export const CITY_ALIASES: Record<string, string> = {
  // -- North America --
  // New York
  "new york": "New York",
  "new york city": "New York",
  "nyc": "New York",
  "manhattan": "New York",
  "the big apple": "New York",
  "brooklyn": "New York",
  "queens": "New York",
  // Los Angeles
  "los angeles": "Los Angeles",
  "la": "Los Angeles",
  "l.a.": "Los Angeles",
  "hollywood": "Los Angeles",
  // San Francisco
  "san francisco": "San Francisco",
  "sf": "San Francisco",
  "frisco": "San Francisco",
  "san fran": "San Francisco",
  // Chicago
  "chicago": "Chicago",
  "chi-town": "Chicago",
  // Boston
  "boston": "Boston",
  // Seattle
  "seattle": "Seattle",
  // Miami
  "miami": "Miami",
  "south beach": "Miami",
  // Washington, D.C.
  "washington, d.c.": "Washington, D.C.",
  "washington dc": "Washington, D.C.",
  "washington d.c.": "Washington, D.C.",
  "dc": "Washington, D.C.",
  "d.c.": "Washington, D.C.",
  // Philadelphia
  "philadelphia": "Philadelphia",
  "philly": "Philadelphia",
  // Denver
  "denver": "Denver",
  // Austin
  "austin": "Austin",
  // Portland
  "portland": "Portland",
  // Atlanta
  "atlanta": "Atlanta",
  "atl": "Atlanta",
  // Dallas
  "dallas": "Dallas",
  // Houston
  "houston": "Houston",
  // Phoenix
  "phoenix": "Phoenix",
  // San Diego
  "san diego": "San Diego",
  // Minneapolis
  "minneapolis": "Minneapolis",
  // Nashville
  "nashville": "Nashville",
  // Detroit
  "detroit": "Detroit",
  // Salt Lake City
  "salt lake city": "Salt Lake City",
  "slc": "Salt Lake City",
  // Las Vegas
  "las vegas": "Las Vegas",
  "vegas": "Las Vegas",
  // Raleigh
  "raleigh": "Raleigh",
  // Charlotte
  "charlotte": "Charlotte",
  // Pittsburgh
  "pittsburgh": "Pittsburgh",
  // Columbus
  "columbus": "Columbus",
  // Indianapolis
  "indianapolis": "Indianapolis",
  "indy": "Indianapolis",
  // San Jose
  "san jose": "San Jose",
  // Toronto
  "toronto": "Toronto",
  "to": "Toronto",
  // Montreal
  "montreal": "Montreal",
  // Vancouver
  "vancouver": "Vancouver",
  // Mexico City
  "mexico city": "Mexico City",
  "cdmx": "Mexico City",
  "ciudad de mexico": "Mexico City",
  "ciudad de méxico": "Mexico City",
  // Bogota
  "bogota": "Bogota",
  "bogotá": "Bogota",
  // Buenos Aires
  "buenos aires": "Buenos Aires",
  // Santiago
  "santiago": "Santiago",
  // Sao Paulo
  "sao paulo": "Sao Paulo",
  "são paulo": "Sao Paulo",
  "sp": "Sao Paulo",
  // Lima
  "lima": "Lima",

  // -- Europe --
  // London
  "london": "London",
  "the city": "London",
  // Paris
  "paris": "Paris",
  // Berlin
  "berlin": "Berlin",
  // Munich
  "munich": "Munich",
  "muenchen": "Munich",
  "münchen": "Munich",
  // Frankfurt
  "frankfurt": "Frankfurt",
  "frankfurt am main": "Frankfurt",
  // Hamburg
  "hamburg": "Hamburg",
  // Cologne
  "cologne": "Cologne",
  "koeln": "Cologne",
  "köln": "Cologne",
  // Dusseldorf
  "dusseldorf": "Dusseldorf",
  "düsseldorf": "Dusseldorf",
  // Stuttgart
  "stuttgart": "Stuttgart",
  // Amsterdam
  "amsterdam": "Amsterdam",
  // Brussels
  "brussels": "Brussels",
  "bruxelles": "Brussels",
  // Zurich
  "zurich": "Zurich",
  "zürich": "Zurich",
  // Geneva
  "geneva": "Geneva",
  "geneve": "Geneva",
  "genève": "Geneva",
  // Vienna
  "vienna": "Vienna",
  "wien": "Vienna",
  // Madrid
  "madrid": "Madrid",
  // Barcelona
  "barcelona": "Barcelona",
  // Lisbon
  "lisbon": "Lisbon",
  "lisboa": "Lisbon",
  // Rome
  "rome": "Rome",
  "roma": "Rome",
  // Milan
  "milan": "Milan",
  "milano": "Milan",
  // Florence
  "florence": "Florence",
  "firenze": "Florence",
  // Naples
  "naples": "Naples",
  "napoli": "Naples",
  // Prague
  "prague": "Prague",
  "praha": "Prague",
  // Warsaw
  "warsaw": "Warsaw",
  "warszawa": "Warsaw",
  // Budapest
  "budapest": "Budapest",
  // Copenhagen
  "copenhagen": "Copenhagen",
  "kobenhavn": "Copenhagen",
  "københavn": "Copenhagen",
  // Stockholm
  "stockholm": "Stockholm",
  // Oslo
  "oslo": "Oslo",
  // Helsinki
  "helsinki": "Helsinki",
  // Dublin
  "dublin": "Dublin",
  // Edinburgh
  "edinburgh": "Edinburgh",
  // Manchester
  "manchester": "Manchester",
  // Athens
  "athens": "Athens",
  // Istanbul
  "istanbul": "Istanbul",
  "constantinople": "Istanbul",
  // Moscow
  "moscow": "Moscow",
  "moskva": "Moscow",
  // Saint Petersburg
  "saint petersburg": "Saint Petersburg",
  "st. petersburg": "Saint Petersburg",
  "st petersburg": "Saint Petersburg",
  "sankt-peterburg": "Saint Petersburg",
  // Bucharest
  "bucharest": "Bucharest",
  "bucuresti": "Bucharest",

  // -- Middle East --
  // Dubai
  "dubai": "Dubai",
  // Tel Aviv
  "tel aviv": "Tel Aviv",
  "tlv": "Tel Aviv",
  // Riyadh
  "riyadh": "Riyadh",
  // Doha
  "doha": "Doha",

  // -- Africa --
  // Cairo
  "cairo": "Cairo",
  // Lagos
  "lagos": "Lagos",
  // Nairobi
  "nairobi": "Nairobi",
  // Cape Town
  "cape town": "Cape Town",
  // Johannesburg
  "johannesburg": "Johannesburg",
  "joburg": "Johannesburg",
  // Casablanca
  "casablanca": "Casablanca",

  // -- Asia --
  // Tokyo
  "tokyo": "Tokyo",
  // Osaka
  "osaka": "Osaka",
  // Seoul
  "seoul": "Seoul",
  // Beijing
  "beijing": "Beijing",
  "peking": "Beijing",
  // Shanghai
  "shanghai": "Shanghai",
  // Guangzhou
  "guangzhou": "Guangzhou",
  "canton": "Guangzhou",
  // Shenzhen
  "shenzhen": "Shenzhen",
  // Hong Kong
  "hong kong": "Hong Kong",
  "hk": "Hong Kong",
  // Taipei
  "taipei": "Taipei",
  // Singapore
  "singapore": "Singapore",
  // Bangkok
  "bangkok": "Bangkok",
  // Ho Chi Minh City
  "ho chi minh city": "Ho Chi Minh City",
  "saigon": "Ho Chi Minh City",
  "hcmc": "Ho Chi Minh City",
  // Kuala Lumpur
  "kuala lumpur": "Kuala Lumpur",
  "kl": "Kuala Lumpur",
  // Jakarta
  "jakarta": "Jakarta",
  // Manila
  "manila": "Manila",
  // Mumbai
  "mumbai": "Mumbai",
  "bombay": "Mumbai",
  // Delhi
  "delhi": "Delhi",
  "new delhi": "Delhi",
  // Bangalore
  "bangalore": "Bangalore",
  "bengaluru": "Bangalore",

  // -- Oceania --
  // Sydney
  "sydney": "Sydney",
  // Melbourne
  "melbourne": "Melbourne",
  // Auckland
  "auckland": "Auckland",
};

// ---------------------------------------------------------------------------
// City -> IANA Timezone Table
//
// Keys are lowercase canonical city names. Values are IANA timezone identifiers.
// ---------------------------------------------------------------------------

export const CITY_TIMEZONES: Record<string, string> = {
  // -- North America --
  "new york": "America/New_York",
  "los angeles": "America/Los_Angeles",
  "san francisco": "America/Los_Angeles",
  "chicago": "America/Chicago",
  "boston": "America/New_York",
  "seattle": "America/Los_Angeles",
  "miami": "America/New_York",
  "washington, d.c.": "America/New_York",
  "philadelphia": "America/New_York",
  "denver": "America/Denver",
  "austin": "America/Chicago",
  "portland": "America/Los_Angeles",
  "atlanta": "America/New_York",
  "dallas": "America/Chicago",
  "houston": "America/Chicago",
  "phoenix": "America/Phoenix",
  "san diego": "America/Los_Angeles",
  "minneapolis": "America/Chicago",
  "nashville": "America/Chicago",
  "detroit": "America/Detroit",
  "salt lake city": "America/Denver",
  "las vegas": "America/Los_Angeles",
  "raleigh": "America/New_York",
  "charlotte": "America/New_York",
  "pittsburgh": "America/New_York",
  "columbus": "America/New_York",
  "indianapolis": "America/Indiana/Indianapolis",
  "san jose": "America/Los_Angeles",
  "toronto": "America/Toronto",
  "montreal": "America/Montreal",
  "vancouver": "America/Vancouver",
  "mexico city": "America/Mexico_City",
  "bogota": "America/Bogota",
  "buenos aires": "America/Argentina/Buenos_Aires",
  "santiago": "America/Santiago",
  "sao paulo": "America/Sao_Paulo",
  "lima": "America/Lima",

  // -- Europe --
  "london": "Europe/London",
  "paris": "Europe/Paris",
  "berlin": "Europe/Berlin",
  "munich": "Europe/Berlin",
  "frankfurt": "Europe/Berlin",
  "hamburg": "Europe/Berlin",
  "cologne": "Europe/Berlin",
  "dusseldorf": "Europe/Berlin",
  "stuttgart": "Europe/Berlin",
  "amsterdam": "Europe/Amsterdam",
  "brussels": "Europe/Brussels",
  "zurich": "Europe/Zurich",
  "geneva": "Europe/Zurich",
  "vienna": "Europe/Vienna",
  "madrid": "Europe/Madrid",
  "barcelona": "Europe/Madrid",
  "lisbon": "Europe/Lisbon",
  "rome": "Europe/Rome",
  "milan": "Europe/Rome",
  "florence": "Europe/Rome",
  "naples": "Europe/Rome",
  "prague": "Europe/Prague",
  "warsaw": "Europe/Warsaw",
  "budapest": "Europe/Budapest",
  "copenhagen": "Europe/Copenhagen",
  "stockholm": "Europe/Stockholm",
  "oslo": "Europe/Oslo",
  "helsinki": "Europe/Helsinki",
  "dublin": "Europe/Dublin",
  "edinburgh": "Europe/London",
  "manchester": "Europe/London",
  "athens": "Europe/Athens",
  "istanbul": "Europe/Istanbul",
  "moscow": "Europe/Moscow",
  "saint petersburg": "Europe/Moscow",
  "bucharest": "Europe/Bucharest",

  // -- Middle East --
  "dubai": "Asia/Dubai",
  "tel aviv": "Asia/Jerusalem",
  "riyadh": "Asia/Riyadh",
  "doha": "Asia/Qatar",

  // -- Africa --
  "cairo": "Africa/Cairo",
  "lagos": "Africa/Lagos",
  "nairobi": "Africa/Nairobi",
  "cape town": "Africa/Johannesburg",
  "johannesburg": "Africa/Johannesburg",
  "casablanca": "Africa/Casablanca",

  // -- Asia --
  "tokyo": "Asia/Tokyo",
  "osaka": "Asia/Tokyo",
  "seoul": "Asia/Seoul",
  "beijing": "Asia/Shanghai",
  "shanghai": "Asia/Shanghai",
  "guangzhou": "Asia/Shanghai",
  "shenzhen": "Asia/Shanghai",
  "hong kong": "Asia/Hong_Kong",
  "taipei": "Asia/Taipei",
  "singapore": "Asia/Singapore",
  "bangkok": "Asia/Bangkok",
  "ho chi minh city": "Asia/Ho_Chi_Minh",
  "kuala lumpur": "Asia/Kuala_Lumpur",
  "jakarta": "Asia/Jakarta",
  "manila": "Asia/Manila",
  "mumbai": "Asia/Kolkata",
  "delhi": "Asia/Kolkata",
  "bangalore": "Asia/Kolkata",

  // -- Oceania --
  "sydney": "Australia/Sydney",
  "melbourne": "Australia/Melbourne",
  "auckland": "Pacific/Auckland",
};

// ---------------------------------------------------------------------------
// Default working hours (local time)
// ---------------------------------------------------------------------------

const WORK_START_HOUR = 9;
const WORK_END_HOUR = 17;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a city name to its canonical form using the alias table.
 *
 * Case-insensitive lookup. Trims whitespace. Returns null for null/empty
 * input. Falls back to the trimmed input string for unknown cities.
 *
 * @param input - City name, alias, or abbreviation
 * @returns Canonical city name, or null for empty/null input
 */
export function resolveCity(
  input: string | null | undefined,
): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const key = trimmed.toLowerCase();
  return CITY_ALIASES[key] ?? trimmed;
}

/**
 * Enhanced city matching with alias resolution.
 *
 * Resolves both city names through the alias table, then compares
 * canonical forms. Backward compatible: exact matches still work.
 * Falls back to case-insensitive comparison for unknown cities.
 *
 * @param a - First city string
 * @param b - Second city string
 * @returns true if cities resolve to the same canonical name
 */
export function matchCityWithAliases(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const resolvedA = resolveCity(a);
  const resolvedB = resolveCity(b);
  if (!resolvedA || !resolvedB) return false;
  return resolvedA.toLowerCase() === resolvedB.toLowerCase();
}

/**
 * Look up the IANA timezone for a city.
 *
 * Resolves aliases first, then looks up in the timezone table.
 * Returns null for unknown cities or null/empty input.
 *
 * @param city - City name, alias, or abbreviation
 * @returns IANA timezone identifier (e.g., "America/New_York"), or null
 */
export function cityToTimezone(
  city: string | null | undefined,
): string | null {
  const canonical = resolveCity(city);
  if (!canonical) return null;
  return CITY_TIMEZONES[canonical.toLowerCase()] ?? null;
}

/**
 * Compute the UTC offset in hours for a given IANA timezone on a specific date.
 *
 * Uses Intl.DateTimeFormat to determine the actual UTC offset, accounting
 * for DST. Returns null for invalid timezones.
 *
 * @param timezone - IANA timezone identifier
 * @param dateStr - Date string (YYYY-MM-DD) for DST calculation
 * @returns UTC offset in hours (e.g., -5 for EST, +1 for CET), or null
 */
function getUtcOffset(timezone: string, dateStr: string): number | null {
  try {
    // Create a date at noon to avoid DST transition edge cases
    const date = new Date(`${dateStr}T12:00:00Z`);

    // Use Intl to get the local time representation in the target timezone
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    const parts = formatter.formatToParts(date);
    const localHour = parseInt(
      parts.find((p) => p.type === "hour")?.value ?? "0",
      10,
    );
    const localDay = parseInt(
      parts.find((p) => p.type === "day")?.value ?? "0",
      10,
    );
    const utcDay = date.getUTCDate();

    // Calculate offset: local hour - UTC hour, adjusting for day boundary
    let offset = localHour - 12; // 12 because we set UTC time to noon
    if (localDay > utcDay) offset += 24;
    if (localDay < utcDay) offset -= 24;

    return offset;
  } catch {
    return null;
  }
}

/**
 * Compute the overlap of working hours between two timezones.
 *
 * Working hours are assumed to be 09:00-17:00 local time in each timezone.
 * Accounts for DST by computing UTC offsets on the given reference date.
 *
 * @param tzA - IANA timezone for party A
 * @param tzB - IANA timezone for party B
 * @param refDate - Reference date (YYYY-MM-DD) for DST calculation
 * @returns Overlap info, or null if no overlap or invalid timezones
 */
export function computeWorkingHoursOverlap(
  tzA: string | null | undefined,
  tzB: string | null | undefined,
  refDate: string,
): WorkingHoursOverlap | null {
  if (!tzA || !tzB) return null;

  const offsetA = getUtcOffset(tzA, refDate);
  const offsetB = getUtcOffset(tzB, refDate);

  if (offsetA === null || offsetB === null) return null;

  // Working hours in UTC for each party
  const aStartUTC = WORK_START_HOUR - offsetA;
  const aEndUTC = WORK_END_HOUR - offsetA;
  const bStartUTC = WORK_START_HOUR - offsetB;
  const bEndUTC = WORK_END_HOUR - offsetB;

  // Compute overlap
  const overlapStart = Math.max(aStartUTC, bStartUTC);
  const overlapEnd = Math.min(aEndUTC, bEndUTC);
  const overlapHours = Math.max(0, overlapEnd - overlapStart);

  if (overlapHours <= 0) return null;

  return {
    startHourUTC: ((overlapStart % 24) + 24) % 24, // Normalize to 0-23
    endHourUTC: ((overlapEnd % 24) + 24) % 24,
    overlapHours,
  };
}

/**
 * Suggest a timezone-aware meeting window within trip dates.
 *
 * If both timezones are known, narrows the window to working hours
 * that overlap between the user's timezone and the contact's timezone.
 * Falls back to the raw trip window when timezone info is unavailable.
 *
 * @param tripStart - ISO 8601 trip start, or null
 * @param tripEnd - ISO 8601 trip end, or null
 * @param userTimezone - IANA timezone of the traveler
 * @param contactTimezone - IANA timezone of the contact
 * @param durationMinutes - Desired meeting duration
 * @returns Meeting window suggestion, or null if no trip dates
 */
export function suggestMeetingWindow(
  tripStart: string | null,
  tripEnd: string | null,
  userTimezone: string | null | undefined,
  contactTimezone: string | null | undefined,
  durationMinutes: number,
): TimezoneAwareMeetingWindow | null {
  if (!tripStart || !tripEnd) return null;

  // Use the trip start date for working hours calculation
  const refDate = tripStart.slice(0, 10);

  const overlap =
    userTimezone && contactTimezone
      ? computeWorkingHoursOverlap(userTimezone, contactTimezone, refDate)
      : null;

  return {
    earliest: tripStart,
    latest: tripEnd,
    suggested_start_hour_utc: overlap ? overlap.startHourUTC : null,
    suggested_end_hour_utc: overlap ? overlap.endHourUTC : null,
    user_timezone: userTimezone ?? null,
    contact_timezone: contactTimezone ?? null,
  };
}
