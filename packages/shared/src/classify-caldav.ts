/**
 * @tminus/shared -- CalDAV event classification for loop prevention.
 *
 * Implements Invariant A and Invariant E for CalDAV (Apple Calendar) events.
 * Uses custom X-TMINUS-* properties on VEVENT to detect managed mirrors,
 * analogous to Google's extendedProperties and Microsoft's open extensions.
 *
 * X-TMINUS-MANAGED:true -- marks the event as a T-Minus managed mirror
 * X-TMINUS-CANONICAL-ID:evt_xxx -- links to the canonical event
 */

import type { EventClassification } from "./types";
import type { ParsedVEvent } from "./caldav-types";

/**
 * Classify a CalDAV VEVENT.
 *
 * Pure function -- no side effects, no mutations, deterministic.
 *
 * Decision logic:
 * 1. No X-TMINUS-MANAGED property => origin (user-created event)
 * 2. X-TMINUS-MANAGED='true' => managed_mirror (T-Minus created it)
 * 3. Otherwise => origin (safe default)
 */
export function classifyCalDavEvent(
  vevent: ParsedVEvent,
): EventClassification {
  if (vevent.xTminusManaged === "true") {
    return "managed_mirror";
  }
  return "origin";
}
