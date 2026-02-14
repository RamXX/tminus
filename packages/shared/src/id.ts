/**
 * @tminus/shared -- ULID generation and prefixed ID utilities.
 *
 * All entity IDs in T-Minus are prefixed ULIDs, e.g. "usr_01HXYZ...".
 * This module provides type-safe generation, parsing, and validation.
 */

import { monotonicFactory } from "ulid";
import { ID_PREFIXES } from "./constants";

// Monotonic ULID generator: within the same millisecond, the random
// component is incremented rather than re-randomised, guaranteeing
// lexicographic sort order for successive calls.
const monotonic = monotonicFactory();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Entity types that have prefixed IDs, derived from ID_PREFIXES keys. */
export type EntityType = keyof typeof ID_PREFIXES;

// Crockford's Base32 character set -- used by ULID
const CROCKFORD_BASE32_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Pre-compute a reverse lookup from prefix string to entity name.
// This avoids O(n) search on every parseId call.
const PREFIX_TO_ENTITY = new Map<string, EntityType>(
  (Object.entries(ID_PREFIXES) as Array<[EntityType, string]>).map(
    ([entity, prefix]) => [prefix, entity],
  ),
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a new prefixed ULID for the given entity type.
 *
 * ULIDs are monotonically increasing: within the same millisecond the
 * random component is incremented, guaranteeing lexicographic sort order.
 *
 * @param entity - The entity type (e.g. "user", "event")
 * @returns A prefixed ULID string (e.g. "usr_01HXYZ...")
 */
export function generateId(entity: EntityType): string {
  return ID_PREFIXES[entity] + monotonic();
}

/**
 * Parse a prefixed ID into its entity type and raw ULID components.
 *
 * @param id - A prefixed ULID string
 * @returns The parsed entity type and raw ULID, or null if the ID is invalid
 */
export function parseId(
  id: string,
): { entity: EntityType; ulid: string } | null {
  if (typeof id !== "string" || id.length < 5) {
    return null;
  }

  // All prefixes are exactly 4 characters
  const prefix = id.slice(0, 4);
  const entity = PREFIX_TO_ENTITY.get(prefix);
  if (entity === undefined) {
    return null;
  }

  const ulidPart = id.slice(4);
  if (!CROCKFORD_BASE32_REGEX.test(ulidPart)) {
    return null;
  }

  return { entity, ulid: ulidPart };
}

/**
 * Validate that a string is a well-formed prefixed ULID.
 *
 * Optionally checks that the prefix matches an expected entity type.
 *
 * @param id - The string to validate
 * @param expectedEntity - Optional entity type the ID must match
 * @returns true if the ID is valid (and matches expectedEntity if provided)
 */
export function isValidId(id: string, expectedEntity?: EntityType): boolean {
  const parsed = parseId(id);
  if (parsed === null) {
    return false;
  }
  if (expectedEntity !== undefined && parsed.entity !== expectedEntity) {
    return false;
  }
  return true;
}
