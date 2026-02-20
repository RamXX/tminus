/**
 * @tminus/shared -- Event classification for loop prevention.
 *
 * Implements Invariant A (every provider event is classified as exactly one of
 * origin, managed_mirror, or foreign_managed) and Invariant E (managed events
 * are never treated as origin).
 *
 * Without correct classification, managed mirror events would be treated as new
 * origin events, creating an infinite sync loop (Risk R1):
 *   A creates mirror in B -> B's webhook fires -> B's event is treated as origin
 *   -> creates mirror back in A -> infinite loop.
 */

import type { GoogleCalendarEvent, EventClassification } from "./types";
import type { MicrosoftGraphEvent } from "./normalize-microsoft";
import {
  EXTENDED_PROP_TMINUS,
  EXTENDED_PROP_MANAGED,
} from "./constants";

/** Open extension name used by T-Minus for Microsoft events. */
const MS_EXTENSION_NAME = "com.tminus.metadata";
/** Category fallback used when Graph delta payload omits open extensions. */
const MS_MANAGED_CATEGORY = "T-Minus Managed";

/**
 * Classify a Google Calendar provider event.
 *
 * Pure function -- no side effects, no mutations, deterministic.
 *
 * @param providerEvent - Raw event from the Google Calendar API
 * @returns Classification: 'origin' | 'managed_mirror' | 'foreign_managed'
 *
 * Decision logic:
 * 1. No extended properties => origin (user-created event)
 * 2. tminus='true' AND managed='true' => managed_mirror (T-Minus created it)
 * 3. Has other extended properties => origin (another system created it;
 *    the foreign_managed type exists for future differentiation)
 */
export function classifyEvent(
  providerEvent: GoogleCalendarEvent,
): EventClassification {
  const extProps = providerEvent.extendedProperties?.private;

  if (!extProps) {
    return "origin";
  }

  // Only classify as managed_mirror when BOTH markers are present and 'true'.
  // This is the critical check for Invariant E / loop prevention.
  if (
    extProps[EXTENDED_PROP_TMINUS] === "true" &&
    extProps[EXTENDED_PROP_MANAGED] === "true"
  ) {
    return "managed_mirror";
  }

  // Has extended properties but not our managed markers.
  // Could be another system's event or partial T-Minus props.
  // Treat as origin (safe default -- better to re-sync than to miss).
  return "origin";
}

/**
 * Classify a Microsoft Graph provider event.
 *
 * Pure function -- no side effects, no mutations, deterministic.
 *
 * Uses open extensions (com.tminus.metadata) and a managed category fallback
 * to detect managed mirrors.
 *
 * @param providerEvent - Raw event from the Microsoft Graph API
 * @returns Classification: 'origin' | 'managed_mirror' | 'foreign_managed'
 *
 * Decision logic:
 * 1. Has com.tminus.metadata with tminus='true' AND managed='true' => managed_mirror
 * 2. Has managed marker category => managed_mirror
 * 3. Otherwise => origin (safe default)
 */
export function classifyMicrosoftEvent(
  providerEvent: MicrosoftGraphEvent,
): EventClassification {
  const extensions = providerEvent.extensions;
  if (extensions && extensions.length > 0) {
    const tminusExt = extensions.find(
      (ext) => ext.extensionName === MS_EXTENSION_NAME,
    );
    if (tminusExt?.tminus === "true" && tminusExt?.managed === "true") {
      return "managed_mirror";
    }
  }

  const categories = providerEvent.categories;
  if (Array.isArray(categories) && categories.includes(MS_MANAGED_CATEGORY)) {
    return "managed_mirror";
  }

  return "origin";
}
