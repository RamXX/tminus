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
export { classifyEvent, classifyMicrosoftEvent } from "./classify";

// Re-export Google event normalization (provider -> ProviderDelta)
export { normalizeGoogleEvent } from "./normalize";

// Re-export Microsoft event normalization (provider -> ProviderDelta)
export { normalizeMicrosoftEvent } from "./normalize-microsoft";
export type { MicrosoftGraphEvent } from "./normalize-microsoft";

// Re-export provider-agnostic abstraction layer
export {
  SUPPORTED_PROVIDERS,
  isSupportedProvider,
  googleClassificationStrategy,
  microsoftClassificationStrategy,
  getClassificationStrategy,
  normalizeProviderEvent,
  createCalendarProvider,
} from "./provider";
export type {
  ProviderType,
  ClassificationStrategy,
} from "./provider";

// Re-export stable hashing utilities
export { computeProjectionHash, computeIdempotencyKey } from "./hash";

// Re-export DO SQLite schema definitions and migration runner
export {
  USER_GRAPH_DO_MIGRATION_V1,
  USER_GRAPH_DO_MIGRATION_V2,
  ACCOUNT_DO_MIGRATION_V1,
  ACCOUNT_DO_MIGRATION_V2,
  ACCOUNT_DO_MIGRATION_V3,
  ACCOUNT_DO_MIGRATION_V4,
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

// Re-export Microsoft Calendar API abstraction layer
export {
  MicrosoftCalendarClient,
  MicrosoftApiError,
  MicrosoftTokenExpiredError,
  MicrosoftResourceNotFoundError,
  MicrosoftRateLimitError,
  MicrosoftSubscriptionValidationError,
  TokenBucket,
} from "./microsoft-api";
export type { MicrosoftClientOptions } from "./microsoft-api";

// Re-export authentication utilities (JWT, password hashing)
export {
  generateJWT,
  verifyJWT,
  generateRefreshToken,
  JWT_EXPIRY_SECONDS,
  REFRESH_TOKEN_EXPIRY_SECONDS,
  hashPassword,
  verifyPassword,
} from "./auth";
export type { JWTPayload, SubscriptionTier } from "./auth";

// Re-export rate limiting middleware
export {
  checkRateLimit,
  computeWindowKey,
  computeWindowReset,
  selectRateLimitConfig,
  getRateLimitIdentity,
  buildRateLimitHeaders,
  buildRateLimitResponse,
  detectAuthEndpoint,
  extractClientIp,
  applyRateLimitHeaders,
  TIER_LIMITS,
  AUTH_ENDPOINT_LIMITS,
  RATE_LIMIT_KEY_PREFIX,
} from "./middleware/rate-limit";
export type {
  RateLimitTier,
  RateLimitResult,
  RateLimitConfig,
  RateLimitKV,
} from "./middleware/rate-limit";

// Re-export security headers middleware
export {
  getSecurityHeaders,
  addSecurityHeaders,
  SECURITY_HEADERS,
  HSTS_MAX_AGE,
} from "./middleware/security";

// Re-export deletion certificate utilities (GDPR compliance)
export {
  generateDeletionCertificate,
  verifyDeletionCertificate,
  computeSha256,
  computeHmacSha256,
} from "./privacy/deletion-certificate";
export type {
  DeletionCertificate,
  DeletionSummary,
  DeletedEntities,
} from "./privacy/deletion-certificate";

// Re-export CORS middleware
export {
  isAllowedOrigin,
  buildCorsHeaders,
  buildPreflightResponse,
  addCorsHeaders,
  PRODUCTION_ORIGINS,
  CORS_ALLOWED_METHODS,
  CORS_ALLOWED_HEADERS,
  CORS_EXPOSED_HEADERS,
  CORS_MAX_AGE,
} from "./middleware/cors";
