/**
 * @tminus/shared -- CalDAV XML request/response builders and parsers.
 *
 * Builds the WebDAV/CalDAV XML request bodies for PROPFIND and REPORT
 * methods, and parses the multistatus XML responses.
 *
 * CalDAV uses WebDAV (RFC 4918) for transport with CalDAV extensions
 * (RFC 4791). XML namespaces:
 * - DAV: (d:) -- WebDAV properties
 * - urn:ietf:params:xml:ns:caldav (c:) -- CalDAV properties
 * - http://apple.com/ns/ical/ (a:) -- Apple extensions
 * - http://calendarserver.org/ns/ (cs:) -- Calendar Server extensions (ctag)
 *
 * No external XML parser dependency -- uses simple string parsing
 * since CalDAV responses have a predictable structure.
 */

import type { CalDavCalendar, CalDavEvent } from "./caldav-types";

// ---------------------------------------------------------------------------
// XML request builders
// ---------------------------------------------------------------------------

/**
 * Build PROPFIND XML to discover the current user principal.
 * First step in CalDAV bootstrap.
 */
export function buildPrincipalPropfind(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:current-user-principal />
  </d:prop>
</d:propfind>`;
}

/**
 * Build PROPFIND XML to discover the calendar home set.
 * Second step: ask the principal URL for calendar-home-set.
 */
export function buildCalendarHomePropfind(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-home-set />
  </d:prop>
</d:propfind>`;
}

/**
 * Build PROPFIND XML to list calendars in a calendar home.
 * Requests displayname, resourcetype, ctag, and calendar-color.
 */
export function buildCalendarListPropfind(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:a="http://apple.com/ns/ical/">
  <d:prop>
    <d:displayname />
    <d:resourcetype />
    <cs:getctag />
    <a:calendar-color />
  </d:prop>
</d:propfind>`;
}

/**
 * Build REPORT XML for calendar-multiget.
 * Fetches full VCALENDAR data for specific event URLs.
 */
export function buildCalendarMultiget(eventHrefs: readonly string[]): string {
  const hrefElements = eventHrefs
    .map((href) => `    <d:href>${escapeXml(href)}</d:href>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag />
    <c:calendar-data />
  </d:prop>
${hrefElements}
</c:calendar-multiget>`;
}

/**
 * Build REPORT XML for calendar-query.
 * Fetches all events in a calendar (used for initial sync).
 */
export function buildCalendarQuery(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag />
    <c:calendar-data />
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT" />
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

/**
 * Build PROPFIND XML to get etags for all events in a calendar.
 * Used for incremental sync: compare etags to detect changes.
 */
export function buildEtagPropfind(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getetag />
  </d:prop>
</d:propfind>`;
}

// ---------------------------------------------------------------------------
// XML response parsers
// ---------------------------------------------------------------------------

/**
 * Extract the current-user-principal href from a PROPFIND response.
 */
export function parsePrincipalResponse(xml: string): string | null {
  return extractTagContent(xml, "current-user-principal", "href");
}

/**
 * Extract the calendar-home-set href from a PROPFIND response.
 */
export function parseCalendarHomeResponse(xml: string): string | null {
  return extractTagContent(xml, "calendar-home-set", "href");
}

/**
 * Parse a calendar list PROPFIND response into CalDavCalendar objects.
 * Filters to only return resources with resourcetype=calendar.
 */
export function parseCalendarListResponse(xml: string): CalDavCalendar[] {
  const responses = extractMultistatusResponses(xml);
  const calendars: CalDavCalendar[] = [];

  for (const resp of responses) {
    // Check if this is a calendar resource
    if (!resp.propstat.includes("<calendar") && !resp.propstat.includes("calendar")) {
      // Check resourcetype more carefully
      const resourceType = extractSimpleTag(resp.propstat, "resourcetype");
      if (resourceType === null || !resourceType.includes("calendar")) {
        continue;
      }
    }

    const href = resp.href;
    const displayName =
      extractSimpleTag(resp.propstat, "displayname") ?? href;
    const ctag = extractSimpleTag(resp.propstat, "getctag") ?? "";
    const color = extractSimpleTag(resp.propstat, "calendar-color") ?? undefined;

    calendars.push({
      href,
      displayName,
      ctag,
      color,
    });
  }

  return calendars;
}

/**
 * Parse a calendar-multiget or calendar-query REPORT response into CalDavEvent objects.
 */
export function parseCalendarDataResponse(xml: string): CalDavEvent[] {
  const responses = extractMultistatusResponses(xml);
  const events: CalDavEvent[] = [];

  for (const resp of responses) {
    const etag = extractSimpleTag(resp.propstat, "getetag")?.replace(/"/g, "") ?? "";
    const icalData = extractSimpleTag(resp.propstat, "calendar-data") ?? "";

    if (icalData.length > 0) {
      events.push({
        href: resp.href,
        etag,
        icalData,
      });
    }
  }

  return events;
}

/**
 * Parse a PROPFIND response for etags (used for change detection).
 * Returns a map of href -> etag.
 */
export function parseEtagResponse(xml: string): Record<string, string> {
  const responses = extractMultistatusResponses(xml);
  const etags: Record<string, string> = {};

  for (const resp of responses) {
    const etag = extractSimpleTag(resp.propstat, "getetag")?.replace(/"/g, "") ?? "";
    if (etag) {
      etags[resp.href] = etag;
    }
  }

  return etags;
}

// ---------------------------------------------------------------------------
// Internal XML helpers
// ---------------------------------------------------------------------------

/** Escape special XML characters. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * A simplified multistatus response entry.
 */
interface MultistatusEntry {
  href: string;
  propstat: string;
}

/**
 * Extract all <response> elements from a multistatus XML response.
 * Returns href and the raw propstat XML for each.
 */
function extractMultistatusResponses(xml: string): MultistatusEntry[] {
  const entries: MultistatusEntry[] = [];

  // Match <response>...</response> blocks (case-insensitive, namespace-aware)
  const responsePattern = /<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi;
  let match;

  while ((match = responsePattern.exec(xml)) !== null) {
    const responseBody = match[1];

    // Extract href
    const hrefMatch = /<(?:[\w-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/i.exec(
      responseBody,
    );
    const href = hrefMatch ? hrefMatch[1].trim() : "";

    if (href) {
      entries.push({ href, propstat: responseBody });
    }
  }

  return entries;
}

/**
 * Extract content nested inside a parent tag, then find a child tag.
 * Used for compound properties like <current-user-principal><href>...</href></current-user-principal>.
 */
function extractTagContent(
  xml: string,
  parentTag: string,
  childTag: string,
): string | null {
  // Match parent tag with optional namespace prefix
  const parentPattern = new RegExp(
    `<(?:[\\w-]+:)?${parentTag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${parentTag}>`,
    "i",
  );
  const parentMatch = parentPattern.exec(xml);
  if (!parentMatch) return null;

  // Extract child tag from parent content
  const childPattern = new RegExp(
    `<(?:[\\w-]+:)?${childTag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${childTag}>`,
    "i",
  );
  const childMatch = childPattern.exec(parentMatch[1]);
  return childMatch ? childMatch[1].trim() : null;
}

/**
 * Extract the text content of a simple XML tag (with optional namespace prefix).
 * Returns null if the tag is not found.
 */
function extractSimpleTag(xml: string, tagName: string): string | null {
  const pattern = new RegExp(
    `<(?:[\\w-]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tagName}>`,
    "i",
  );
  const match = pattern.exec(xml);
  return match ? match[1].trim() : null;
}
