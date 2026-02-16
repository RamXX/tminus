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
  BILLING_CATEGORIES,
  isValidBillingCategory,
  RELATIONSHIP_CATEGORIES,
  isValidRelationshipCategory,
  INTERACTION_OUTCOMES,
  OUTCOME_WEIGHTS,
  isValidOutcome,
  getOutcomeWeight,
} from "./constants";
export type { BillingCategory, RelationshipCategory, InteractionOutcome } from "./constants";

// Re-export ID utilities
export { generateId, parseId, isValidId } from "./id";
export type { EntityType } from "./id";

// Re-export policy compiler
export { compileProjection } from "./policy";

// Re-export event classification (Invariants A & E, loop prevention)
export { classifyEvent, classifyMicrosoftEvent } from "./classify";
export { classifyCalDavEvent } from "./classify-caldav";

// Re-export Google event normalization (provider -> ProviderDelta)
export { normalizeGoogleEvent } from "./normalize";

// Re-export Microsoft event normalization (provider -> ProviderDelta)
export { normalizeMicrosoftEvent } from "./normalize-microsoft";
export type { MicrosoftGraphEvent } from "./normalize-microsoft";

// Re-export CalDAV (Apple Calendar) event normalization
export { normalizeCalDavEvent } from "./normalize-caldav";

// Re-export provider-agnostic abstraction layer
export {
  SUPPORTED_PROVIDERS,
  isSupportedProvider,
  googleClassificationStrategy,
  microsoftClassificationStrategy,
  caldavClassificationStrategy,
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
  USER_GRAPH_DO_MIGRATION_V4,
  ACCOUNT_DO_MIGRATION_V1,
  ACCOUNT_DO_MIGRATION_V2,
  ACCOUNT_DO_MIGRATION_V3,
  ACCOUNT_DO_MIGRATION_V4,
  ACCOUNT_DO_MIGRATION_V5,
  USER_GRAPH_DO_MIGRATION_V6,
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

// Re-export CalDAV (Apple Calendar) API abstraction layer
export {
  CalDavClient,
  CalDavApiError,
  CalDavAuthError,
  CalDavNotFoundError,
  CalDavConflictError,
} from "./caldav-client";
export type {
  CalDavCredentials,
  CalDavCalendar,
  CalDavCalendarSyncState,
  CalDavEvent,
  ParsedVEvent,
  CalDavClientConfig,
  CalDavWriteResult,
} from "./caldav-types";

// Re-export CalDAV XML builders and parsers
export {
  buildPrincipalPropfind,
  buildCalendarHomePropfind,
  buildCalendarListPropfind,
  buildCalendarMultiget,
  buildCalendarQuery,
  buildEtagPropfind,
  parsePrincipalResponse,
  parseCalendarHomeResponse,
  parseCalendarListResponse,
  parseCalendarDataResponse,
  parseEtagResponse,
} from "./caldav-xml";

// Re-export iCalendar parser (VEVENT -> ParsedVEvent)
export {
  parseVEvents,
  unfoldLines,
  unescapeText,
  parsePropertyLine,
  icalDateTimeToEventDateTime,
} from "./ical-parse";

// Re-export ICS feed utilities (zero-auth onboarding, Phase 6C)
export {
  validateFeedUrl,
  normalizeIcsFeedEvents,
} from "./ics-feed";
export type {
  FeedValidationResult,
  NormalizedFeedEvent,
} from "./ics-feed";

// Re-export full ICS feed parser (TM-d17.2: RFC 5545 full parsing)
export {
  parseIcsFeed,
  expandRecurrence,
  extractMeetingUrl,
  NormalizedFeedEventSchema,
  ParsedAttendeeSchema,
} from "./ics-feed-parser";
export type {
  ExtendedFeedEvent,
  ParsedComponent,
  ParsedAttendee,
  ParsedOrganizer,
  ParsedTodo,
  ParsedFreeBusy,
  FreeBusyPeriod,
  ParsedTimezone,
  TimezoneComponent,
  ParsedFeed,
  RecurrenceExpansionOptions,
  RecurrenceInstance,
} from "./ics-feed-parser";

// Re-export ICS feed refresh & staleness detection (TM-d17.3)
export {
  computeContentHash,
  detectFeedChanges,
  classifyFeedError,
  computeStaleness,
  isRateLimited,
  buildConditionalHeaders,
  diffFeedEvents,
  DEFAULT_REFRESH_INTERVAL_MS,
  STALE_MULTIPLIER,
  DEAD_THRESHOLD_MS,
  MIN_REFRESH_INTERVAL_MS,
  VALID_REFRESH_INTERVALS,
} from "./ics-feed-refresh";
export type {
  FeedRefreshConfig,
  FeedRefreshState,
  FeedChangeResult,
  FeedErrorClassification,
  FeedStaleness,
  FeedEventDiff,
} from "./ics-feed-refresh";

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

// Re-export drift computation (relationship tracking, Phase 4)
export {
  computeDrift,
  matchEventParticipants,
  computeDriftBadge,
  driftEntryBadge,
  matchCity,
  categoryDurationMinutes,
  enrichSuggestionsWithTimeWindows,
  enrichWithTimezoneWindows,
} from "./drift";
export type {
  DriftInput,
  DriftEntry,
  DriftReport,
  DriftBadge,
  DriftAlert,
  SuggestedTimeWindow,
  ReconnectionSuggestion,
} from "./drift";

// Re-export reputation scoring (relationship tracking, Phase 4)
export {
  computeReliabilityScore,
  computeReciprocityScore,
  computeReputation,
  computeDecayFactor,
} from "./reputation";
export type { LedgerInput, ReputationResult } from "./reputation";

// Re-export pre-meeting briefing assembly (Phase 4C)
export {
  extractTopics,
  summarizeLastInteraction,
  assembleBriefing,
} from "./briefing";
export type {
  BriefingParticipantInput,
  BriefingParticipant,
  EventBriefing,
} from "./briefing";

// Re-export excuse generator (Phase 4C)
export {
  EXCUSE_TEMPLATES,
  buildExcusePrompt,
  parseExcuseResponse,
} from "./excuse";
export type {
  ExcuseTone,
  TruthLevel,
  ExcuseContext,
  ExcuseOutput,
} from "./excuse";

// Re-export milestone tracking (Phase 4B)
export {
  MILESTONE_KINDS,
  isValidMilestoneKind,
  isValidMilestoneDate,
  computeNextOccurrence,
  daysBetween,
  expandMilestonesToBusy,
} from "./milestones";
export type {
  MilestoneKind,
  Milestone,
  UpcomingMilestone,
} from "./milestones";

// Re-export geo-matching engine (Phase 4B: reconnection intelligence)
export {
  resolveCity,
  matchCityWithAliases,
  cityToTimezone,
  computeWorkingHoursOverlap,
  suggestMeetingWindow,
  CITY_ALIASES,
  CITY_TIMEZONES,
} from "./geo";
export type {
  WorkingHoursOverlap,
  TimezoneAwareMeetingWindow,
} from "./geo";

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

// Re-export iCalendar generation (Phase 5A: CalDAV feed)
export {
  formatICalDate,
  formatICalDateTime,
  buildVEvent,
  buildVCalendar,
  collectTimezones,
  foldLine,
} from "./ical";
export type { VCalendarOptions } from "./ical";

// Re-export what-if simulation engine
export {
  simulate,
  computeWeeklyHours,
  countConflicts,
  checkConstraintViolations,
  computeBurnoutRiskDelta,
  computeCommitmentComplianceDelta,
  generateRecurringEvents,
  SIMULATION_WEEKS,
} from "./simulation";
export type {
  SimulationEvent,
  SimulationConstraint,
  SimulationCommitment,
  SimulationSnapshot,
  SimulationScenario,
  AddCommitmentScenario,
  AddRecurringEventScenario,
  ChangeWorkingHoursScenario,
  ImpactReport,
  ComplianceEntry,
} from "./simulation";

// Re-export cognitive load engine (scheduling intelligence)
export {
  computeCognitiveLoad,
  computeMeetingDensity,
  computeContextSwitches,
  computeDeepWorkBlocks,
  computeFragmentationScore,
  computeAggregateScore,
} from "./cognitive-load";
export type {
  CognitiveLoadInput,
  CognitiveLoadResult,
  WorkingHoursConstraint,
  AggregateMetrics,
} from "./cognitive-load";

// Re-export context-switch cost estimation (scheduling intelligence)
export {
  classifyEventCategory,
  lookupTransitionCost,
  COST_MATRIX,
  DEFAULT_TRANSITION_COST,
  computeTransitions,
  computeDailySwitchCost,
  computeWeeklySwitchCost,
  generateClusteringSuggestions,
} from "./context-switch";
export type {
  EventCategory,
  Transition,
  WeeklySwitchCost,
  ClusteringSuggestion,
  ContextSwitchResult,
} from "./context-switch";

// Re-export deep work window optimization (scheduling intelligence)
export {
  detectDeepWorkBlocks,
  computeDeepWorkReport,
  evaluateDeepWorkImpact,
  suggestDeepWorkOptimizations,
} from "./deep-work";
export type {
  DeepWorkBlock,
  DeepWorkReport,
  DeepWorkImpact,
  DeepWorkSuggestion,
} from "./deep-work";

// Re-export temporal risk scoring engine (scheduling intelligence)
export {
  RISK_LEVELS,
  computeBurnoutRisk,
  computeTravelOverload,
  computeStrategicDrift,
  computeOverallRisk,
  generateRiskRecommendations,
  getRiskLevel,
} from "./risk-scoring";
export type {
  RiskLevel,
  CognitiveLoadHistoryEntry,
  CategoryAllocation,
  RiskScoreResult,
} from "./risk-scoring";

// Re-export org-level policy merge engine
export {
  mergeWorkingHours,
  mergeVipPriority,
  mergeAccountLimit,
  mergeProjectionDetail,
  mergeOrgAndUserPolicies,
  validateOrgPolicyConfig,
  isValidOrgPolicyType,
  VALID_ORG_POLICY_TYPES,
  DETAIL_LEVEL_RANK,
} from "./policy-merge";
export type {
  OrgPolicyType as OrgMergePolicyType,
  WorkingHoursPolicy,
  VipPriorityPolicy,
  AccountLimitPolicy,
  ProjectionDetailPolicy,
  VipEntry,
  OrgPolicy,
  UserPolicies,
  AccountLimitResult,
  MergedPolicies,
} from "./policy-merge";

// Re-export push notification types and utilities
export {
  NOTIFICATION_TYPES,
  isValidNotificationType,
  buildAPNsPayload,
  DEFAULT_DEEP_LINK_PATHS,
  defaultNotificationSettings,
  shouldDeliverNotification,
  isWithinQuietHours,
  parseTimeToMinutes,
  getLocalMinutesSinceMidnight,
} from "./push";
export type {
  NotificationType,
  PushMessage,
  APNsPayload,
  NotificationPreference,
  NotificationSettings,
  QuietHoursConfig,
  DevicePlatform,
  DeviceTokenRow as SharedDeviceTokenRow,
} from "./push";

// Re-export probabilistic availability modeling (scheduling intelligence)
export {
  computeEventBusyProbability,
  computeSlotFreeProbability,
  computeProbabilisticAvailability,
  computeMultiParticipantProbability,
  DEFAULT_CONFIRMED_BUSY_PROBABILITY,
  DEFAULT_TENTATIVE_BUSY_PROBABILITY,
} from "./probabilistic-availability";
export type {
  ProbabilisticEvent,
  ProbabilisticSlot,
  ProbabilisticAvailabilityInput,
  ProbabilisticAvailabilityResult,
  CancellationHistory,
  CancellationHistoryEntry,
} from "./probabilistic-availability";

// Re-export upgrade prompt logic (TM-d17.4: Smart Upgrade Prompts)
export {
  evaluatePromptTriggers,
  shouldShowPrompt,
  createDismissal,
  isDismissed,
  isSessionPromptShown,
  getPromptMessage,
  DEFAULT_ENGAGEMENT_THRESHOLDS,
  DISMISSAL_DURATION_MS,
} from "./upgrade-prompts";
export type {
  PromptTriggerType,
  EngagementMetrics,
  FeedContext,
  PromptThresholds,
  PromptTriggerResult,
  PromptDismissal,
  PromptSettings,
} from "./upgrade-prompts";

// Re-export ICS-to-OAuth upgrade flow (TM-d17.5: OAuth Upgrade Flow)
export {
  detectProvider,
  matchEventsByICalUID,
  matchEventsByCompositeKey,
  matchEvents,
  mergeIcsWithProvider,
  planUpgrade,
  planDowngrade,
} from "./ics-upgrade";
export type {
  DetectedProvider,
  IcsEvent,
  ProviderAttendee,
  ProviderOrganizer,
  ConferenceData,
  ProviderEvent,
  EventMatch,
  MatchResult,
  MergedEvent,
  UpgradeInput,
  UpgradePlan,
  DowngradeInput,
  DowngradePlan,
} from "./ics-upgrade";

// Re-export JWT assertion for service account impersonation (Phase 6D)
export {
  buildJwtAssertion,
  exchangeJwtForToken,
  getImpersonationToken,
  importPrivateKey,
  validateServiceAccountKey,
  DELEGATION_SCOPES,
} from "./jwt-assertion";
export type {
  ServiceAccountKey,
  TokenResponse,
} from "./jwt-assertion";

// Re-export service account encryption (Phase 6D, AD-2 compliance)
export {
  importMasterKeyForServiceAccount,
  encryptServiceAccountKey,
  decryptServiceAccountKey,
} from "./service-account-crypto";
export type {
  EncryptedServiceAccountEnvelope,
} from "./service-account-crypto";

// Re-export delegation Zod schemas (TM-9iu.2: runtime validation)
export {
  ServiceAccountKeySchema,
  EncryptedEnvelopeSchema,
  KeyMetadataSchema,
  DelegationHealthStatusSchema,
  HealthCheckResultSchema,
  CachedImpersonationTokenSchema,
  OrgDelegationConfigSchema,
  parseServiceAccountKey,
  safeParseServiceAccountKey,
  parseEncryptedEnvelope,
  computeRotationDueDate,
  isKeyRotationDue,
  ROTATION_REMINDER_DAYS,
} from "./delegation-schemas";
export type {
  ValidatedServiceAccountKey,
  ValidatedEncryptedEnvelope,
  KeyMetadata,
  DelegationHealthStatus,
  HealthCheckResult,
  CachedImpersonationToken,
  OrgDelegationConfig,
} from "./delegation-schemas";

// Re-export delegation service (TM-9iu.2: credential management + token cache)
export { DelegationService } from "./delegation-service";
export type {
  DelegationStore,
  DelegationRecord,
  CachedTokenRecord,
  AuditLogEntry,
  RotationResult,
  ImpersonationResult,
} from "./delegation-service";
