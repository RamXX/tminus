/**
 * @tminus/shared -- Stable hashing for projection write-skipping.
 *
 * Provides deterministic hashing for:
 * - Invariant C: Projection hash (determines whether a mirror write is needed)
 * - Invariant D: Idempotency key (prevents duplicate writes)
 *
 * Uses Web Crypto API (crypto.subtle) which is available in both
 * Cloudflare Workers and Node.js >= 18.
 */

import type { DetailLevel, CalendarKind, ProjectedEvent } from "./types";

/**
 * Convert an ArrayBuffer to a lowercase hex string.
 */
function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const hexParts: string[] = [];
  for (const byte of bytes) {
    hexParts.push(byte.toString(16).padStart(2, "0"));
  }
  return hexParts.join("");
}

/**
 * Compute SHA-256 hash of a string using the Web Crypto API.
 */
async function sha256(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return bufferToHex(digest);
}

/**
 * Deterministically serialize a value for hashing.
 * Sorts object keys, normalizes undefined to null.
 */
function deterministicSerialize(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val === undefined) return null;
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      // Sort object keys for deterministic serialization
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        sorted[k] = val[k as keyof typeof val];
      }
      return sorted;
    }
    return val;
  });
}

/**
 * Compute a stable projection hash for write-skipping (Invariant C).
 *
 * The hash covers canonical_event_id + detail_level + calendar_kind + the
 * content-relevant fields of the projection (summary, description, location,
 * start, end, transparency, visibility). Extended properties are excluded
 * because they are tracking metadata, not user-visible content.
 *
 * projected_hash = SHA-256(canonical_event_id + detail_level + calendar_kind + sorted content fields)
 *
 * @param canonicalEventId - The canonical event's stable ID
 * @param detailLevel - The projection detail level (BUSY/TITLE/FULL)
 * @param calendarKind - The target calendar kind (BUSY_OVERLAY/TRUE_MIRROR)
 * @param projection - The projected event payload
 * @returns A 64-character lowercase hex SHA-256 digest
 */
export async function computeProjectionHash(
  canonicalEventId: string,
  detailLevel: DetailLevel,
  calendarKind: CalendarKind,
  projection: ProjectedEvent,
): Promise<string> {
  // Extract only content-relevant fields (exclude extendedProperties metadata)
  const contentFields = {
    summary: projection.summary,
    description: projection.description,
    location: projection.location,
    start: projection.start,
    end: projection.end,
    transparency: projection.transparency,
    visibility: projection.visibility,
  };

  const hashInput = deterministicSerialize({
    canonical_event_id: canonicalEventId,
    detail_level: detailLevel,
    calendar_kind: calendarKind,
    content: contentFields,
  });

  return sha256(hashInput);
}

/**
 * Compute an idempotency key for a mirror write operation (Invariant D).
 *
 * idempotency_key = SHA-256(canonical_event_id + target_account_id + projected_hash)
 *
 * This ensures that the exact same write operation always produces the same
 * idempotency key, preventing duplicate writes even if the message is
 * delivered multiple times.
 *
 * @param canonicalEventId - The canonical event's stable ID
 * @param targetAccountId - The account receiving the mirror write
 * @param projectedHash - The projection hash from computeProjectionHash()
 * @returns A 64-character lowercase hex SHA-256 digest
 */
export async function computeIdempotencyKey(
  canonicalEventId: string,
  targetAccountId: string,
  projectedHash: string,
): Promise<string> {
  const input = deterministicSerialize({
    canonical_event_id: canonicalEventId,
    target_account_id: targetAccountId,
    projected_hash: projectedHash,
  });

  return sha256(input);
}
