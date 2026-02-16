/**
 * Zod schemas for user discovery and federation (TM-9iu.3).
 *
 * Validates:
 * 1. Google Directory API user list responses
 * 2. Discovery configuration (OU filters, exclusions, sync mode)
 * 3. User lifecycle state transitions
 *
 * Design decision: optional config fields use undefined (not false)
 * for "not configured by admin / use system default" per project learnings.
 */

import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Google Directory API user schema
// ---------------------------------------------------------------------------

/**
 * Schema for a single user from Google Admin SDK Directory API.
 * Reference: https://developers.google.com/admin-sdk/directory/reference/rest/v1/users
 *
 * We only extract fields needed for discovery and lifecycle management.
 */
export const DirectoryUserSchema = z.object({
  /** Google's internal user ID (stable across email changes). */
  id: z.string().min(1),
  /** Primary email address. */
  primaryEmail: z.string().email(),
  /** Full display name. */
  name: z.object({
    fullName: z.string().optional(),
    givenName: z.string().optional(),
    familyName: z.string().optional(),
  }),
  /** Whether the user is suspended in Google Workspace. */
  suspended: z.boolean().default(false),
  /** Whether the user is archived. Treated as suspended for our purposes. */
  archived: z.boolean().default(false),
  /** Organizational unit path (e.g., "/Engineering/Backend"). */
  orgUnitPath: z.string().optional(),
  /** Whether the user account is deleted. */
  isEnrolledIn2Sv: z.boolean().optional(),
});

export type DirectoryUser = z.infer<typeof DirectoryUserSchema>;

/**
 * Schema for the full Directory API list response (paginated).
 */
export const DirectoryListResponseSchema = z.object({
  users: z.array(DirectoryUserSchema).default([]),
  nextPageToken: z.string().optional(),
});

export type DirectoryListResponse = z.infer<typeof DirectoryListResponseSchema>;

// ---------------------------------------------------------------------------
// Discovery configuration schema
// ---------------------------------------------------------------------------

/**
 * Discovery sync mode: proactive vs lazy.
 * - proactive: sync calendars in background even before user visits
 * - lazy: only sync when user first visits T-Minus
 */
export const SyncModeSchema = z.enum(["proactive", "lazy"]);
export type SyncMode = z.infer<typeof SyncModeSchema>;

/**
 * Per-org discovery configuration.
 * Controls which users are discovered and how their calendars are synced.
 */
export const DiscoveryConfigSchema = z.object({
  /** Delegation ID this config belongs to. */
  delegationId: z.string().min(1),
  /** OU paths to include (undefined = all users in the domain). */
  ouFilter: z.array(z.string().min(1)).optional(),
  /** Emails to exclude from discovery (admin opt-out list). */
  excludedEmails: z.array(z.string().email()).optional(),
  /** Sync mode: proactive or lazy. Default: lazy. */
  syncMode: SyncModeSchema.default("lazy"),
  /** Days to retain data after user removal. Default: 30. */
  retentionDays: z.number().int().min(1).max(365).default(30),
});

export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

// ---------------------------------------------------------------------------
// User lifecycle state machine
// ---------------------------------------------------------------------------

/**
 * Valid discovered user statuses.
 * State transitions:
 *   active -> suspended (user suspended in Workspace)
 *   active -> removed (user deleted from Workspace)
 *   suspended -> active (user reactivated in Workspace)
 *   suspended -> removed (suspended user then deleted)
 *   removed is terminal (cleanup happens per retention policy)
 */
export const DiscoveredUserStatusSchema = z.enum(["active", "suspended", "removed"]);
export type DiscoveredUserStatus = z.infer<typeof DiscoveredUserStatusSchema>;

/**
 * Represents a discovered user with their lifecycle state.
 */
export const DiscoveredUserSchema = z.object({
  discoveryId: z.string().min(1),
  delegationId: z.string().min(1),
  googleUserId: z.string().min(1),
  email: z.string().email(),
  displayName: z.string().nullable().default(null),
  orgUnitPath: z.string().nullable().default(null),
  status: DiscoveredUserStatusSchema,
  /** Account ID if an AccountDO has been created for this user. */
  accountId: z.string().nullable().default(null),
  lastSyncedAt: z.string().datetime().nullable().default(null),
  discoveredAt: z.string().datetime(),
  statusChangedAt: z.string().datetime(),
  removedAt: z.string().datetime().nullable().default(null),
});

export type DiscoveredUser = z.infer<typeof DiscoveredUserSchema>;

// ---------------------------------------------------------------------------
// Lifecycle transition validation
// ---------------------------------------------------------------------------

/** Valid state transitions for discovered user lifecycle. */
const VALID_TRANSITIONS: Record<DiscoveredUserStatus, DiscoveredUserStatus[]> = {
  active: ["suspended", "removed"],
  suspended: ["active", "removed"],
  removed: [], // terminal state
};

/**
 * Check if a lifecycle state transition is valid.
 */
export function isValidTransition(
  from: DiscoveredUserStatus,
  to: DiscoveredUserStatus,
): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/**
 * Get allowed transitions from a given status.
 */
export function getAllowedTransitions(
  status: DiscoveredUserStatus,
): readonly DiscoveredUserStatus[] {
  return VALID_TRANSITIONS[status];
}

// ---------------------------------------------------------------------------
// Rate limiting for Directory API
// ---------------------------------------------------------------------------

/**
 * Google Admin SDK Directory API rate limits.
 * Reference: https://developers.google.com/admin-sdk/directory/v1/limits
 *
 * Queries per second (QPS) for users.list: default is 2400/min = 40/sec.
 * We use conservative limits to stay well within quotas.
 */
export const DIRECTORY_API_RATE_LIMITS = {
  /** Maximum requests per minute to Directory API. */
  requestsPerMinute: 60,
  /** Maximum page size for users.list (Google maximum is 500). */
  maxPageSize: 100,
  /** Minimum delay between consecutive API calls (ms). */
  minDelayMs: 1000,
} as const;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a Directory API user list response with Zod validation.
 * Throws ZodError if the response shape is unexpected.
 */
export function parseDirectoryResponse(data: unknown): DirectoryListResponse {
  return DirectoryListResponseSchema.parse(data);
}

/**
 * Parse and validate a discovery configuration.
 */
export function parseDiscoveryConfig(data: unknown): DiscoveryConfig {
  return DiscoveryConfigSchema.parse(data);
}

/**
 * Determine the lifecycle status for a Directory API user.
 * Maps Google Workspace user state to our discovery lifecycle state.
 */
export function determineUserStatus(
  dirUser: DirectoryUser,
): DiscoveredUserStatus {
  if (dirUser.suspended || dirUser.archived) {
    return "suspended";
  }
  return "active";
}

/**
 * Filter users based on OU filter configuration.
 * If no OU filter is configured (undefined), all users pass.
 * OU matching is hierarchical: /Engineering matches /Engineering/Backend.
 */
export function filterByOU(
  users: DirectoryUser[],
  ouFilter?: string[],
): DirectoryUser[] {
  if (!ouFilter || ouFilter.length === 0) {
    return users;
  }

  return users.filter((user) => {
    if (!user.orgUnitPath) return false;
    return ouFilter.some((filterPath) =>
      user.orgUnitPath!.startsWith(filterPath),
    );
  });
}

/**
 * Filter out excluded email addresses.
 * Comparison is case-insensitive per email spec.
 */
export function filterExcluded(
  users: DirectoryUser[],
  excludedEmails?: string[],
): DirectoryUser[] {
  if (!excludedEmails || excludedEmails.length === 0) {
    return users;
  }

  const excludeSet = new Set(excludedEmails.map((e) => e.toLowerCase()));
  return users.filter(
    (user) => !excludeSet.has(user.primaryEmail.toLowerCase()),
  );
}
