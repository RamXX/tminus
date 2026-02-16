/**
 * User discovery and automatic calendar federation service (TM-9iu.3).
 *
 * Provides:
 * 1. User discovery via Google Admin SDK Directory API
 * 2. Automatic AccountDO federation for discovered users
 * 3. User lifecycle management (active -> suspended -> removed)
 * 4. Discovery configuration (OU filters, exclusions, sync mode)
 * 5. Rate-limited Directory API calls (BR-4)
 * 6. Cleanup of removed users per retention policy (BR-3)
 *
 * Security invariants:
 * - Directory API calls use service account impersonation via DelegationService
 * - Admin scopes (admin.directory.user.readonly) required for user discovery
 * - All lifecycle transitions are auditable via the delegation audit log
 */

// setTimeout is available in all target runtimes (Workers, Node) but not
// in the default @cloudflare/workers-types declarations.
declare function setTimeout(callback: () => void, ms: number): unknown;

import type { FetchFn } from "./google-api";
import type {
  DirectoryUser,
  DirectoryListResponse,
  DiscoveredUser,
  DiscoveredUserStatus,
  DiscoveryConfig,
  SyncMode,
} from "./discovery-schemas";
import {
  parseDirectoryResponse,
  determineUserStatus,
  filterByOU,
  filterExcluded,
  isValidTransition,
  DIRECTORY_API_RATE_LIMITS,
} from "./discovery-schemas";
import { generateId } from "./id";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Google Admin SDK Directory API base URL. */
const DIRECTORY_API_BASE = "https://admin.googleapis.com/admin/directory/v1";

/** Scope required for listing users via Admin SDK. */
export const DIRECTORY_API_SCOPE =
  "https://www.googleapis.com/auth/admin.directory.user.readonly";

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

/**
 * Discovery store interface. Decoupled from D1 for testability.
 * Implementations can use D1Database or in-memory for tests.
 */
export interface DiscoveryStore {
  /** Get discovery config for a delegation. */
  getConfig(delegationId: string): Promise<DiscoveryConfig | null>;

  /** Create or update discovery config. */
  upsertConfig(config: DiscoveryConfig & { configId: string }): Promise<void>;

  /** Get all discovered users for a delegation. */
  getDiscoveredUsers(
    delegationId: string,
    status?: DiscoveredUserStatus,
  ): Promise<DiscoveredUser[]>;

  /** Get a discovered user by delegation + Google user ID. */
  getDiscoveredUser(
    delegationId: string,
    googleUserId: string,
  ): Promise<DiscoveredUser | null>;

  /** Get a discovered user by delegation + email. */
  getDiscoveredUserByEmail(
    delegationId: string,
    email: string,
  ): Promise<DiscoveredUser | null>;

  /** Create a new discovered user record. */
  createDiscoveredUser(user: DiscoveredUser): Promise<void>;

  /** Update an existing discovered user record. */
  updateDiscoveredUser(
    discoveryId: string,
    updates: Partial<DiscoveredUser>,
  ): Promise<void>;

  /** Get discovered users who were removed more than retentionDays ago. */
  getRemovedUsersForCleanup(
    delegationId: string,
    beforeDate: string,
  ): Promise<DiscoveredUser[]>;

  /** Delete a discovered user record (permanent cleanup). */
  deleteDiscoveredUser(discoveryId: string): Promise<void>;

  /** Update the last discovery timestamp for a config. */
  updateLastDiscoveryAt(
    delegationId: string,
    timestamp: string,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Token provider interface
// ---------------------------------------------------------------------------

/**
 * Provides access tokens for API calls.
 * In production, this delegates to DelegationService.getImpersonationToken().
 * In tests, this can return a mock token.
 */
export interface TokenProvider {
  /** Get an access token for the Directory API. */
  getDirectoryToken(delegationId: string, adminEmail: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Discovery result types
// ---------------------------------------------------------------------------

/** Result of a single discovery run. */
export interface DiscoveryResult {
  /** Delegation ID this discovery ran for. */
  delegationId: string;
  /** Domain that was discovered. */
  domain: string;
  /** Number of users found in Directory API. */
  totalUsersFound: number;
  /** Number of users after OU filter + exclusion filter. */
  filteredUsersCount: number;
  /** New users discovered (not previously seen). */
  newUsers: DiscoveredUser[];
  /** Users whose status changed (e.g., active -> suspended). */
  statusChanges: Array<{
    user: DiscoveredUser;
    previousStatus: DiscoveredUserStatus;
    newStatus: DiscoveredUserStatus;
  }>;
  /** Users removed from the org since last discovery. */
  removedUsers: DiscoveredUser[];
  /** Timestamp of this discovery run. */
  discoveredAt: string;
}

/** Result of a cleanup operation. */
export interface CleanupResult {
  delegationId: string;
  /** Number of users cleaned up (records deleted). */
  cleanedUp: number;
  /** Discovery IDs of cleaned up users. */
  cleanedUpIds: string[];
}

/** Result of federation (AccountDO creation) for a discovered user. */
export interface FederationResult {
  discoveryId: string;
  email: string;
  accountId: string;
  syncMode: SyncMode;
}

// ---------------------------------------------------------------------------
// DiscoveryService
// ---------------------------------------------------------------------------

/**
 * Core discovery service for automatic user discovery and calendar federation.
 *
 * Lifecycle:
 * 1. Admin configures delegation (TM-9iu.1/2)
 * 2. Discovery service runs (cron or manual) to find org users
 * 3. New users get AccountDO entries with delegation credentials
 * 4. Suspended/removed users get lifecycle state changes
 * 5. Removed users cleaned up per retention policy
 */
export class DiscoveryService {
  private readonly store: DiscoveryStore;
  private readonly tokenProvider: TokenProvider;
  private readonly fetchFn: FetchFn;

  constructor(
    store: DiscoveryStore,
    tokenProvider: TokenProvider,
    fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
  ) {
    this.store = store;
    this.tokenProvider = tokenProvider;
    this.fetchFn = fetchFn;
  }

  // -------------------------------------------------------------------------
  // Discovery Configuration (AC-5, AC-6)
  // -------------------------------------------------------------------------

  /**
   * Get discovery configuration for a delegation.
   * Returns null if no config exists (use defaults).
   */
  async getConfig(delegationId: string): Promise<DiscoveryConfig | null> {
    return this.store.getConfig(delegationId);
  }

  /**
   * Create or update discovery configuration.
   * Admin can set OU filters, exclusion list, sync mode, and retention days.
   */
  async upsertConfig(config: DiscoveryConfig): Promise<void> {
    const configId = generateId("discovery");
    await this.store.upsertConfig({ ...config, configId });
  }

  // -------------------------------------------------------------------------
  // User Discovery (AC-1)
  // -------------------------------------------------------------------------

  /**
   * Discover users in an org via Google Admin SDK Directory API.
   *
   * Fetches all users (paginated), applies OU filter and exclusion list,
   * then reconciles against known discovered users to detect:
   * - New users (not previously seen)
   * - Status changes (active -> suspended, suspended -> active)
   * - Removed users (in our DB but not in Directory API response)
   *
   * Rate limiting: respects DIRECTORY_API_RATE_LIMITS (BR-4).
   */
  async discoverUsers(
    delegationId: string,
    domain: string,
    adminEmail: string,
  ): Promise<DiscoveryResult> {
    const now = new Date().toISOString();

    // 1. Get discovery configuration (defaults if not set)
    const config = await this.store.getConfig(delegationId);
    const ouFilter = config?.ouFilter;
    const excludedEmails = config?.excludedEmails;

    // 2. Fetch all users from Directory API (paginated)
    const allDirectoryUsers = await this.fetchAllDirectoryUsers(
      delegationId,
      adminEmail,
      domain,
    );

    // 3. Apply filters
    const afterOU = filterByOU(allDirectoryUsers, ouFilter);
    const filteredUsers = filterExcluded(afterOU, excludedEmails);

    // 4. Get existing discovered users
    const existingUsers = await this.store.getDiscoveredUsers(delegationId);
    const existingByGoogleId = new Map(
      existingUsers.map((u) => [u.googleUserId, u]),
    );

    // 5. Build set of discovered Google user IDs
    const discoveredGoogleIds = new Set(filteredUsers.map((u) => u.id));

    // 6. Reconcile: detect new, changed, and removed users
    const newUsers: DiscoveredUser[] = [];
    const statusChanges: Array<{
      user: DiscoveredUser;
      previousStatus: DiscoveredUserStatus;
      newStatus: DiscoveredUserStatus;
    }> = [];

    for (const dirUser of filteredUsers) {
      const existing = existingByGoogleId.get(dirUser.id);
      const newStatus = determineUserStatus(dirUser);

      if (!existing) {
        // New user discovered
        const discoveredUser: DiscoveredUser = {
          discoveryId: generateId("discovery"),
          delegationId,
          googleUserId: dirUser.id,
          email: dirUser.primaryEmail,
          displayName: dirUser.name.fullName ?? null,
          orgUnitPath: dirUser.orgUnitPath ?? null,
          status: newStatus,
          accountId: null,
          lastSyncedAt: null,
          discoveredAt: now,
          statusChangedAt: now,
          removedAt: null,
        };
        await this.store.createDiscoveredUser(discoveredUser);
        newUsers.push(discoveredUser);
      } else if (existing.status !== newStatus && existing.status !== "removed") {
        // Status changed
        if (isValidTransition(existing.status, newStatus)) {
          const previousStatus = existing.status;
          await this.store.updateDiscoveredUser(existing.discoveryId, {
            status: newStatus,
            statusChangedAt: now,
            email: dirUser.primaryEmail,
            displayName: dirUser.name.fullName ?? null,
            orgUnitPath: dirUser.orgUnitPath ?? null,
          });
          const updatedUser: DiscoveredUser = {
            ...existing,
            status: newStatus,
            statusChangedAt: now,
            email: dirUser.primaryEmail,
            displayName: dirUser.name.fullName ?? null,
            orgUnitPath: dirUser.orgUnitPath ?? null,
          };
          statusChanges.push({
            user: updatedUser,
            previousStatus,
            newStatus,
          });
        }
      } else if (existing.status !== "removed") {
        // Update metadata (email/name/OU changes) even if status unchanged
        await this.store.updateDiscoveredUser(existing.discoveryId, {
          email: dirUser.primaryEmail,
          displayName: dirUser.name.fullName ?? null,
          orgUnitPath: dirUser.orgUnitPath ?? null,
        });
      }
    }

    // 7. Mark users not in Directory response as removed
    // Only mark active/suspended users as removed (not already removed)
    const removedUsers: DiscoveredUser[] = [];
    for (const existing of existingUsers) {
      if (
        existing.status !== "removed" &&
        !discoveredGoogleIds.has(existing.googleUserId)
      ) {
        if (isValidTransition(existing.status, "removed")) {
          await this.store.updateDiscoveredUser(existing.discoveryId, {
            status: "removed",
            statusChangedAt: now,
            removedAt: now,
          });
          const removedUser: DiscoveredUser = {
            ...existing,
            status: "removed",
            statusChangedAt: now,
            removedAt: now,
          };
          removedUsers.push(removedUser);
        }
      }
    }

    // 8. Update last discovery timestamp
    await this.store.updateLastDiscoveryAt(delegationId, now);

    return {
      delegationId,
      domain,
      totalUsersFound: allDirectoryUsers.length,
      filteredUsersCount: filteredUsers.length,
      newUsers,
      statusChanges,
      removedUsers,
      discoveredAt: now,
    };
  }

  // -------------------------------------------------------------------------
  // Federation (AC-2)
  // -------------------------------------------------------------------------

  /**
   * Federate a specific discovered user.
   *
   * @param delegationId - The delegation this user belongs to
   * @param googleUserId - The Google user ID to federate
   * @param accountCreator - Callback that creates the AccountDO and returns its ID
   */
  async federateDiscoveredUser(
    delegationId: string,
    googleUserId: string,
    accountCreator: (user: DiscoveredUser) => Promise<string>,
  ): Promise<FederationResult> {
    const user = await this.store.getDiscoveredUser(delegationId, googleUserId);
    if (!user) {
      throw new Error(
        `Discovered user not found: delegation=${delegationId}, googleUserId=${googleUserId}`,
      );
    }

    if (user.status !== "active") {
      throw new Error(
        `Cannot federate user in status '${user.status}': ${user.email}`,
      );
    }

    if (user.accountId) {
      // Already federated
      const config = await this.store.getConfig(delegationId);
      return {
        discoveryId: user.discoveryId,
        email: user.email,
        accountId: user.accountId,
        syncMode: config?.syncMode ?? "lazy",
      };
    }

    // Create AccountDO via callback
    const accountId = await accountCreator(user);

    // Update discovered user with account reference
    await this.store.updateDiscoveredUser(user.discoveryId, {
      accountId,
    });

    const config = await this.store.getConfig(delegationId);

    return {
      discoveryId: user.discoveryId,
      email: user.email,
      accountId,
      syncMode: config?.syncMode ?? "lazy",
    };
  }

  /**
   * Federate all active, un-federated users for a delegation.
   *
   * Used in proactive sync mode to pre-create AccountDO entries
   * for all discovered users in the background.
   */
  async federateAllPending(
    delegationId: string,
    accountCreator: (user: DiscoveredUser) => Promise<string>,
  ): Promise<FederationResult[]> {
    const users = await this.store.getDiscoveredUsers(delegationId, "active");
    const results: FederationResult[] = [];

    for (const user of users) {
      if (!user.accountId) {
        const result = await this.federateDiscoveredUser(
          delegationId,
          user.googleUserId,
          accountCreator,
        );
        results.push(result);
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Lifecycle Management (AC-3, AC-4)
  // -------------------------------------------------------------------------

  /**
   * Transition a discovered user's lifecycle status.
   *
   * Validates the transition is legal per the state machine:
   *   active -> suspended | removed
   *   suspended -> active | removed
   *   removed -> (terminal, no transitions)
   */
  async transitionUserStatus(
    discoveryId: string,
    newStatus: DiscoveredUserStatus,
    delegationId: string,
  ): Promise<DiscoveredUser> {
    const users = await this.store.getDiscoveredUsers(delegationId);
    const user = users.find((u) => u.discoveryId === discoveryId);
    if (!user) {
      throw new Error(`Discovered user not found: ${discoveryId}`);
    }

    if (!isValidTransition(user.status, newStatus)) {
      throw new Error(
        `Invalid transition: ${user.status} -> ${newStatus} for user ${user.email}`,
      );
    }

    const now = new Date().toISOString();
    const updates: Partial<DiscoveredUser> = {
      status: newStatus,
      statusChangedAt: now,
    };

    if (newStatus === "removed") {
      updates.removedAt = now;
    }

    await this.store.updateDiscoveredUser(discoveryId, updates);

    return { ...user, ...updates };
  }

  /**
   * Clean up removed users past their retention period (BR-3).
   *
   * Finds users whose removedAt + retentionDays has passed,
   * then deletes their discovery records and associated data.
   *
   * @param accountCleaner - Callback to clean up the AccountDO/events
   */
  async cleanupRemovedUsers(
    delegationId: string,
    accountCleaner?: (accountId: string) => Promise<void>,
  ): Promise<CleanupResult> {
    const config = await this.store.getConfig(delegationId);
    const retentionDays = config?.retentionDays ?? 30;

    // Compute cutoff date
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffIso = cutoff.toISOString();

    const usersToClean = await this.store.getRemovedUsersForCleanup(
      delegationId,
      cutoffIso,
    );

    const cleanedUpIds: string[] = [];

    for (const user of usersToClean) {
      // Clean up associated AccountDO if exists
      if (user.accountId && accountCleaner) {
        await accountCleaner(user.accountId);
      }

      // Delete the discovery record
      await this.store.deleteDiscoveredUser(user.discoveryId);
      cleanedUpIds.push(user.discoveryId);
    }

    return {
      delegationId,
      cleanedUp: cleanedUpIds.length,
      cleanedUpIds,
    };
  }

  // -------------------------------------------------------------------------
  // Query helpers
  // -------------------------------------------------------------------------

  /**
   * Get all discovered users for a delegation, optionally filtered by status.
   */
  async getDiscoveredUsers(
    delegationId: string,
    status?: DiscoveredUserStatus,
  ): Promise<DiscoveredUser[]> {
    return this.store.getDiscoveredUsers(delegationId, status);
  }

  /**
   * Check if a user email is already discovered for a delegation.
   */
  async isUserDiscovered(
    delegationId: string,
    email: string,
  ): Promise<boolean> {
    const user = await this.store.getDiscoveredUserByEmail(delegationId, email);
    return user !== null && user.status !== "removed";
  }

  // -------------------------------------------------------------------------
  // Directory API calls (internal, rate-limited per BR-4)
  // -------------------------------------------------------------------------

  /**
   * Fetch all users from Google Admin SDK Directory API.
   * Handles pagination and rate limiting.
   *
   * Uses service account impersonation with admin.directory.user.readonly scope.
   */
  private async fetchAllDirectoryUsers(
    delegationId: string,
    adminEmail: string,
    domain: string,
  ): Promise<DirectoryUser[]> {
    const accessToken = await this.tokenProvider.getDirectoryToken(
      delegationId,
      adminEmail,
    );

    const allUsers: DirectoryUser[] = [];
    let pageToken: string | undefined;
    let requestCount = 0;

    do {
      // Rate limiting (BR-4)
      if (requestCount > 0) {
        await this.delay(DIRECTORY_API_RATE_LIMITS.minDelayMs);
      }

      // Check rate limit
      if (requestCount >= DIRECTORY_API_RATE_LIMITS.requestsPerMinute) {
        throw new Error(
          `Directory API rate limit reached: ${requestCount} requests in this discovery run`,
        );
      }

      const url = this.buildDirectoryUrl(domain, pageToken);
      const response = await this.fetchFn(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(
          `Directory API request failed (${response.status}): ${errorText}`,
        );
      }

      const data = await response.json();
      const parsed = parseDirectoryResponse(data);

      allUsers.push(...parsed.users);
      pageToken = parsed.nextPageToken;
      requestCount++;
    } while (pageToken);

    return allUsers;
  }

  /**
   * Build the Directory API URL for listing users in a domain.
   */
  private buildDirectoryUrl(
    domain: string,
    pageToken?: string,
  ): string {
    const params = new URLSearchParams({
      domain,
      maxResults: String(DIRECTORY_API_RATE_LIMITS.maxPageSize),
      projection: "basic",
      orderBy: "email",
    });

    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    return `${DIRECTORY_API_BASE}/users?${params.toString()}`;
  }

  /**
   * Delay utility for rate limiting.
   * In tests, this can be overridden via the constructor.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
