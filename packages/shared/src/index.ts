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
  GoogleCalendarEvent,
  EventClassification,
  CanonicalEvent,
  ProjectedEvent,
  PolicyEdge,
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

// Re-export ID utilities
export { generateId, parseId, isValidId } from "./id";
export type { EntityType } from "./id";

// Re-export policy compiler
export { compileProjection } from "./policy";

// Re-export event classification (Invariants A & E, loop prevention)
export { classifyEvent } from "./classify";

// Re-export Google event normalization (provider -> ProviderDelta)
export { normalizeGoogleEvent } from "./normalize";

// Re-export stable hashing utilities
export { computeProjectionHash, computeIdempotencyKey } from "./hash";

// Re-export DO SQLite schema definitions and migration runner
export {
  USER_GRAPH_DO_MIGRATION_V1,
  ACCOUNT_DO_MIGRATION_V1,
  USER_GRAPH_DO_MIGRATIONS,
  ACCOUNT_DO_MIGRATIONS,
  applyMigrations,
  getSchemaVersion,
} from "./schema";
export type { Migration, SqlStorageLike, SqlStorageCursorLike } from "./schema";

// Re-export Google Calendar API abstraction layer
export {
  GoogleCalendarClient,
  GoogleApiError,
  TokenExpiredError,
  ResourceNotFoundError,
  SyncTokenExpiredError,
  RateLimitError,
} from "./google-api";
export type {
  FetchFn,
  CalendarProvider,
  ListEventsResponse,
  CalendarListEntry,
  WatchResponse,
} from "./google-api";
