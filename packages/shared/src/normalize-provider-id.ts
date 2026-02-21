/**
 * Provider event ID canonicalization.
 *
 * Google Calendar (and occasionally Microsoft Graph) returns provider_event_id
 * values with inconsistent URL encoding: the same logical event can appear as
 * plain text, single-encoded, or double-encoded depending on the API path,
 * webhook payload, or watch notification that delivered it.
 *
 * Previously the codebase tried up to 3 variants at every lookup via
 * providerEventIdVariants(). This module replaces that O(n)-per-lookup
 * approach with a single canonical form at ingestion time: fully decoded.
 *
 * The canonical form is the result of repeatedly calling decodeURIComponent()
 * until the value stabilizes (no more percent-encoded sequences remain, or
 * decoding produces no change).
 *
 * Applied at:
 * - sync-consumer (delta ingestion)
 * - webhook (before SYNC_QUEUE enqueue)
 * - UserGraphDO.applyProviderDelta (defense-in-depth)
 *
 * Phase 3 (future story): remove providerEventIdVariants fallback after
 * cron migration has normalized all stored values.
 */

/**
 * Canonicalize a provider event ID by fully decoding all URL encoding layers.
 *
 * Repeatedly applies decodeURIComponent until the value is stable (idempotent).
 * Handles:
 * - Plain IDs (no-op, returned as-is)
 * - Single-encoded IDs (one decode pass)
 * - Double/triple-encoded IDs (multiple decode passes)
 * - Partial encoding (decoded as far as possible)
 * - Malformed percent sequences (returns best-effort decode, breaks on error)
 * - Empty strings (returned as-is)
 *
 * @param providerEventId - The raw provider event ID from any source
 * @returns The fully-decoded canonical form
 */
export function canonicalizeProviderEventId(providerEventId: string): string {
  let result = providerEventId;
  let prev = "";
  while (result !== prev) {
    prev = result;
    try {
      result = decodeURIComponent(result);
    } catch {
      // Malformed percent sequence -- stop decoding, return what we have
      break;
    }
  }
  return result;
}
