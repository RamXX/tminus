/**
 * @tminus/shared -- shared types, constants, and utilities
 * for the T-Minus calendar federation engine.
 */

/** Application name constant. */
export const APP_NAME = "tminus" as const;

/** Current schema version for event-sourced journals. */
export const SCHEMA_VERSION = 1 as const;

// Re-export all domain types
export type {
  UserId,
  AccountId,
  EventId,
  PolicyId,
  CalendarId,
  JournalId,
  DetailLevel,
  CalendarKind,
  MirrorState,
  EventDateTime,
  CanonicalEvent,
  ProjectedEvent,
  ProviderDelta,
  SyncIncrementalMessage,
  SyncFullMessage,
  UpsertMirrorMessage,
  DeleteMirrorMessage,
  ReconcileAccountMessage,
  ApplyResult,
  AccountHealth,
  ApiResponse,
} from "./types";

// Re-export all constants
export {
  EXTENDED_PROP_TMINUS,
  EXTENDED_PROP_MANAGED,
  EXTENDED_PROP_CANONICAL_ID,
  EXTENDED_PROP_ORIGIN_ACCOUNT,
  BUSY_OVERLAY_CALENDAR_NAME,
  DEFAULT_DETAIL_LEVEL,
  DEFAULT_CALENDAR_KIND,
  ID_PREFIXES,
} from "./constants";
