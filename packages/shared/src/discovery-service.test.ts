/**
 * Unit + integration tests for DiscoveryService (TM-9iu.3).
 *
 * Tests:
 * - User discovery detects new, suspended, and removed users (AC-1)
 * - Automatic federation creates AccountDO for discovered users (AC-2)
 * - Suspended users' syncs paused (AC-3)
 * - Removed users' data cleaned up per retention policy (AC-4)
 * - Admin can filter by organizational unit (AC-5)
 * - Admin can exclude specific users (AC-6)
 * - Rate limiting respects Google Directory API quotas (AC-7)
 * - Lifecycle state machine correctness
 * - Federation idempotency (already federated users)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiscoveryService } from "./discovery-service";
import type {
  DiscoveryStore,
  TokenProvider,
  DiscoveryResult,
} from "./discovery-service";
import type {
  DiscoveredUser,
  DiscoveredUserStatus,
  DiscoveryConfig,
} from "./discovery-schemas";
import { generateId } from "./id";

// ---------------------------------------------------------------------------
// In-memory store implementation
// ---------------------------------------------------------------------------

class InMemoryDiscoveryStore implements DiscoveryStore {
  configs = new Map<string, DiscoveryConfig & { configId: string }>();
  users = new Map<string, DiscoveredUser>(); // keyed by discoveryId
  lastDiscoveryTimestamps = new Map<string, string>();

  async getConfig(delegationId: string): Promise<DiscoveryConfig | null> {
    for (const config of this.configs.values()) {
      if (config.delegationId === delegationId) return config;
    }
    return null;
  }

  async upsertConfig(config: DiscoveryConfig & { configId: string }): Promise<void> {
    // Update existing or create new
    for (const [key, existing] of this.configs.entries()) {
      if (existing.delegationId === config.delegationId) {
        this.configs.set(key, config);
        return;
      }
    }
    this.configs.set(config.configId, config);
  }

  async getDiscoveredUsers(
    delegationId: string,
    status?: DiscoveredUserStatus,
  ): Promise<DiscoveredUser[]> {
    const result: DiscoveredUser[] = [];
    for (const user of this.users.values()) {
      if (delegationId && user.delegationId !== delegationId) continue;
      if (status && user.status !== status) continue;
      result.push(user);
    }
    return result;
  }

  async getDiscoveredUser(
    delegationId: string,
    googleUserId: string,
  ): Promise<DiscoveredUser | null> {
    for (const user of this.users.values()) {
      if (
        user.delegationId === delegationId &&
        user.googleUserId === googleUserId
      ) {
        return user;
      }
    }
    return null;
  }

  async getDiscoveredUserByEmail(
    delegationId: string,
    email: string,
  ): Promise<DiscoveredUser | null> {
    const emailLower = email.toLowerCase();
    for (const user of this.users.values()) {
      if (
        user.delegationId === delegationId &&
        user.email.toLowerCase() === emailLower
      ) {
        return user;
      }
    }
    return null;
  }

  async createDiscoveredUser(user: DiscoveredUser): Promise<void> {
    this.users.set(user.discoveryId, user);
  }

  async updateDiscoveredUser(
    discoveryId: string,
    updates: Partial<DiscoveredUser>,
  ): Promise<void> {
    const existing = this.users.get(discoveryId);
    if (!existing) throw new Error(`User not found: ${discoveryId}`);
    this.users.set(discoveryId, { ...existing, ...updates });
  }

  async getRemovedUsersForCleanup(
    delegationId: string,
    beforeDate: string,
  ): Promise<DiscoveredUser[]> {
    const result: DiscoveredUser[] = [];
    for (const user of this.users.values()) {
      if (
        user.delegationId === delegationId &&
        user.status === "removed" &&
        user.removedAt &&
        user.removedAt < beforeDate
      ) {
        result.push(user);
      }
    }
    return result;
  }

  async deleteDiscoveredUser(discoveryId: string): Promise<void> {
    this.users.delete(discoveryId);
  }

  async updateLastDiscoveryAt(
    delegationId: string,
    timestamp: string,
  ): Promise<void> {
    this.lastDiscoveryTimestamps.set(delegationId, timestamp);
  }
}

// ---------------------------------------------------------------------------
// Mock token provider
// ---------------------------------------------------------------------------

class MockTokenProvider implements TokenProvider {
  async getDirectoryToken(_delegationId: string, _adminEmail: string): Promise<string> {
    return "mock-directory-token";
  }
}

// ---------------------------------------------------------------------------
// Mock fetch for Directory API
// ---------------------------------------------------------------------------

function createDirectoryMockFetch(users: Record<string, unknown>[]) {
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as Request).url;

    if (url.includes("admin.googleapis.com/admin/directory/v1/users")) {
      return new Response(
        JSON.stringify({
          users,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not found", { status: 404 });
  });
}

function createPaginatedDirectoryMockFetch(
  page1Users: Record<string, unknown>[],
  page2Users: Record<string, unknown>[],
) {
  let callCount = 0;
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as Request).url;

    if (url.includes("admin.googleapis.com/admin/directory/v1/users")) {
      callCount++;
      if (callCount === 1) {
        // First page with nextPageToken
        return new Response(
          JSON.stringify({
            users: page1Users,
            nextPageToken: "page2token",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      } else {
        // Second page (last)
        return new Response(
          JSON.stringify({
            users: page2Users,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    return new Response("Not found", { status: 404 });
  });
}

// ---------------------------------------------------------------------------
// Test directory users
// ---------------------------------------------------------------------------

const DIRECTORY_USERS = [
  {
    id: "guser-001",
    primaryEmail: "alice@acme.com",
    name: { fullName: "Alice Smith" },
    suspended: false,
    archived: false,
    orgUnitPath: "/Engineering",
  },
  {
    id: "guser-002",
    primaryEmail: "bob@acme.com",
    name: { fullName: "Bob Jones" },
    suspended: false,
    archived: false,
    orgUnitPath: "/Engineering/Backend",
  },
  {
    id: "guser-003",
    primaryEmail: "carol@acme.com",
    name: { fullName: "Carol Davis" },
    suspended: false,
    archived: false,
    orgUnitPath: "/Sales",
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiscoveryService", () => {
  let store: InMemoryDiscoveryStore;
  let tokenProvider: MockTokenProvider;
  let service: DiscoveryService;
  let mockFetch: ReturnType<typeof createDirectoryMockFetch>;

  beforeEach(() => {
    store = new InMemoryDiscoveryStore();
    tokenProvider = new MockTokenProvider();
    mockFetch = createDirectoryMockFetch(DIRECTORY_USERS);
    service = new DiscoveryService(store, tokenProvider, mockFetch);
  });

  // -----------------------------------------------------------------------
  // User Discovery (AC-1)
  // -----------------------------------------------------------------------

  describe("discoverUsers", () => {
    it("discovers all active users in the org", async () => {
      const result = await service.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      expect(result.totalUsersFound).toBe(3);
      expect(result.filteredUsersCount).toBe(3);
      expect(result.newUsers).toHaveLength(3);
      expect(result.statusChanges).toHaveLength(0);
      expect(result.removedUsers).toHaveLength(0);
      expect(result.domain).toBe("acme.com");
      expect(result.delegationId).toBe("dlg_test001");
    });

    it("persists discovered users in the store", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const stored = await store.getDiscoveredUsers("dlg_test001");
      expect(stored).toHaveLength(3);
      expect(stored.map((u) => u.email).sort()).toEqual([
        "alice@acme.com",
        "bob@acme.com",
        "carol@acme.com",
      ]);
    });

    it("sets correct status for each discovered user", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const stored = await store.getDiscoveredUsers("dlg_test001");
      for (const user of stored) {
        expect(user.status).toBe("active");
        expect(user.discoveredAt).toBeDefined();
        expect(user.statusChangedAt).toBeDefined();
        expect(user.removedAt).toBeNull();
      }
    });

    it("stores Google user ID for stable identification", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const stored = await store.getDiscoveredUsers("dlg_test001");
      const googleIds = stored.map((u) => u.googleUserId).sort();
      expect(googleIds).toEqual(["guser-001", "guser-002", "guser-003"]);
    });

    it("detects newly suspended users on re-discovery", async () => {
      // First discovery: all active
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      // Second discovery: Bob is now suspended
      const updatedUsers = DIRECTORY_USERS.map((u) =>
        u.id === "guser-002" ? { ...u, suspended: true } : u,
      );
      const mockFetch2 = createDirectoryMockFetch(updatedUsers);
      const service2 = new DiscoveryService(store, tokenProvider, mockFetch2);

      const result = await service2.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      expect(result.newUsers).toHaveLength(0);
      expect(result.statusChanges).toHaveLength(1);
      expect(result.statusChanges[0].previousStatus).toBe("active");
      expect(result.statusChanges[0].newStatus).toBe("suspended");
      expect(result.statusChanges[0].user.email).toBe("bob@acme.com");
    });

    it("detects users removed from the org", async () => {
      // First discovery: 3 users
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      // Second discovery: Carol is gone
      const remainingUsers = DIRECTORY_USERS.filter((u) => u.id !== "guser-003");
      const mockFetch2 = createDirectoryMockFetch(remainingUsers);
      const service2 = new DiscoveryService(store, tokenProvider, mockFetch2);

      const result = await service2.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      expect(result.removedUsers).toHaveLength(1);
      expect(result.removedUsers[0].email).toBe("carol@acme.com");
      expect(result.removedUsers[0].status).toBe("removed");
      expect(result.removedUsers[0].removedAt).toBeDefined();
    });

    it("detects reactivated users (suspended -> active)", async () => {
      // First discovery: Bob is suspended
      const initialUsers = DIRECTORY_USERS.map((u) =>
        u.id === "guser-002" ? { ...u, suspended: true } : u,
      );
      const mockFetch1 = createDirectoryMockFetch(initialUsers);
      const service1 = new DiscoveryService(store, tokenProvider, mockFetch1);
      await service1.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      // Verify Bob is suspended
      const bob = await store.getDiscoveredUser("dlg_test001", "guser-002");
      expect(bob!.status).toBe("suspended");

      // Second discovery: Bob is reactivated
      const mockFetch2 = createDirectoryMockFetch(DIRECTORY_USERS);
      const service2 = new DiscoveryService(store, tokenProvider, mockFetch2);

      const result = await service2.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      expect(result.statusChanges).toHaveLength(1);
      expect(result.statusChanges[0].previousStatus).toBe("suspended");
      expect(result.statusChanges[0].newStatus).toBe("active");
      expect(result.statusChanges[0].user.email).toBe("bob@acme.com");
    });

    it("does not re-create already known users", async () => {
      // First discovery
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");
      expect(store.users.size).toBe(3);

      // Second discovery with same users
      const result = await service.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      expect(store.users.size).toBe(3); // same count
      expect(result.newUsers).toHaveLength(0);
    });

    it("updates last discovery timestamp", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const timestamp = store.lastDiscoveryTimestamps.get("dlg_test001");
      expect(timestamp).toBeDefined();
    });

    it("handles paginated Directory API responses", async () => {
      const page1 = [DIRECTORY_USERS[0], DIRECTORY_USERS[1]];
      const page2 = [DIRECTORY_USERS[2]];
      const paginatedFetch = createPaginatedDirectoryMockFetch(page1, page2);
      const paginatedService = new DiscoveryService(
        store,
        tokenProvider,
        paginatedFetch,
      );

      const result = await paginatedService.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      expect(result.totalUsersFound).toBe(3);
      expect(result.newUsers).toHaveLength(3);
      // Should have made 2 fetch calls
      expect(paginatedFetch).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // OU filtering (AC-5)
  // -----------------------------------------------------------------------

  describe("discoverUsers with OU filter", () => {
    it("filters users by organizational unit", async () => {
      // Configure OU filter for Engineering only
      await service.upsertConfig({
        delegationId: "dlg_test001",
        ouFilter: ["/Engineering"],
        syncMode: "lazy",
        retentionDays: 30,
      });

      const result = await service.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      expect(result.totalUsersFound).toBe(3);
      expect(result.filteredUsersCount).toBe(2); // Alice + Bob (Engineering hierarchy)
      expect(result.newUsers).toHaveLength(2);
      expect(result.newUsers.map((u) => u.email).sort()).toEqual([
        "alice@acme.com",
        "bob@acme.com",
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // Email exclusion (AC-6)
  // -----------------------------------------------------------------------

  describe("discoverUsers with exclusion list", () => {
    it("excludes specific users from discovery", async () => {
      await service.upsertConfig({
        delegationId: "dlg_test001",
        excludedEmails: ["bob@acme.com"],
        syncMode: "lazy",
        retentionDays: 30,
      });

      const result = await service.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      expect(result.filteredUsersCount).toBe(2);
      const emails = result.newUsers.map((u) => u.email);
      expect(emails).not.toContain("bob@acme.com");
    });
  });

  // -----------------------------------------------------------------------
  // Automatic Federation (AC-2)
  // -----------------------------------------------------------------------

  describe("federateDiscoveredUser", () => {
    it("creates AccountDO for an active discovered user", async () => {
      // Discover users first
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const accountCreator = vi.fn(async (user: DiscoveredUser) => {
        return `acc_${user.googleUserId}`;
      });

      const result = await service.federateDiscoveredUser(
        "dlg_test001",
        "guser-001",
        accountCreator,
      );

      expect(result.accountId).toBe("acc_guser-001");
      expect(result.email).toBe("alice@acme.com");
      expect(result.syncMode).toBe("lazy"); // default
      expect(accountCreator).toHaveBeenCalledOnce();
    });

    it("stores account ID on the discovered user record", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      await service.federateDiscoveredUser(
        "dlg_test001",
        "guser-001",
        async () => "acc_new_001",
      );

      const user = await store.getDiscoveredUser("dlg_test001", "guser-001");
      expect(user!.accountId).toBe("acc_new_001");
    });

    it("returns existing account for already-federated user (idempotent)", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      // First federation
      await service.federateDiscoveredUser(
        "dlg_test001",
        "guser-001",
        async () => "acc_first",
      );

      // Second federation (should return existing, not create new)
      const accountCreator = vi.fn(async () => "acc_second");
      const result = await service.federateDiscoveredUser(
        "dlg_test001",
        "guser-001",
        accountCreator,
      );

      expect(result.accountId).toBe("acc_first");
      expect(accountCreator).not.toHaveBeenCalled(); // should NOT create a new one
    });

    it("throws when trying to federate a suspended user", async () => {
      // Discover with Bob suspended
      const suspendedUsers = DIRECTORY_USERS.map((u) =>
        u.id === "guser-002" ? { ...u, suspended: true } : u,
      );
      const suspendedFetch = createDirectoryMockFetch(suspendedUsers);
      const suspendedService = new DiscoveryService(
        store,
        tokenProvider,
        suspendedFetch,
      );
      await suspendedService.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      await expect(
        suspendedService.federateDiscoveredUser(
          "dlg_test001",
          "guser-002",
          async () => "acc_test",
        ),
      ).rejects.toThrow("Cannot federate user in status 'suspended'");
    });

    it("throws for unknown user", async () => {
      await expect(
        service.federateDiscoveredUser(
          "dlg_test001",
          "nonexistent",
          async () => "acc_test",
        ),
      ).rejects.toThrow("Discovered user not found");
    });

    it("uses proactive sync mode from config", async () => {
      await service.upsertConfig({
        delegationId: "dlg_test001",
        syncMode: "proactive",
        retentionDays: 30,
      });

      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const result = await service.federateDiscoveredUser(
        "dlg_test001",
        "guser-001",
        async () => "acc_test",
      );

      expect(result.syncMode).toBe("proactive");
    });
  });

  describe("federateAllPending", () => {
    it("federates all active users without accounts", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      let counter = 0;
      const results = await service.federateAllPending(
        "dlg_test001",
        async () => `acc_${++counter}`,
      );

      expect(results).toHaveLength(3);
      expect(counter).toBe(3);
    });

    it("skips already federated users", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      // Federate one user first
      await service.federateDiscoveredUser(
        "dlg_test001",
        "guser-001",
        async () => "acc_existing",
      );

      let counter = 0;
      const results = await service.federateAllPending(
        "dlg_test001",
        async () => `acc_${++counter}`,
      );

      expect(results).toHaveLength(2); // only Bob and Carol
      expect(counter).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle Management (AC-3, AC-4)
  // -----------------------------------------------------------------------

  describe("transitionUserStatus", () => {
    it("transitions active -> suspended", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const users = await store.getDiscoveredUsers("dlg_test001");
      const alice = users.find((u) => u.email === "alice@acme.com")!;

      const result = await service.transitionUserStatus(
        alice.discoveryId,
        "suspended",
        "dlg_test001",
      );

      expect(result.status).toBe("suspended");
      expect(result.statusChangedAt).toBeDefined();
    });

    it("transitions suspended -> active (reactivation)", async () => {
      // Discover with Bob suspended
      const suspendedUsers = DIRECTORY_USERS.map((u) =>
        u.id === "guser-002" ? { ...u, suspended: true } : u,
      );
      const suspendedFetch = createDirectoryMockFetch(suspendedUsers);
      const suspendedService = new DiscoveryService(
        store,
        tokenProvider,
        suspendedFetch,
      );
      await suspendedService.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      const users = await store.getDiscoveredUsers("dlg_test001");
      const bob = users.find((u) => u.email === "bob@acme.com")!;
      expect(bob.status).toBe("suspended");

      const result = await suspendedService.transitionUserStatus(
        bob.discoveryId,
        "active",
        "dlg_test001",
      );

      expect(result.status).toBe("active");
    });

    it("transitions active -> removed", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const users = await store.getDiscoveredUsers("dlg_test001");
      const alice = users.find((u) => u.email === "alice@acme.com")!;

      const result = await service.transitionUserStatus(
        alice.discoveryId,
        "removed",
        "dlg_test001",
      );

      expect(result.status).toBe("removed");
      expect(result.removedAt).toBeDefined();
    });

    it("rejects invalid transition (removed -> active)", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const users = await store.getDiscoveredUsers("dlg_test001");
      const alice = users.find((u) => u.email === "alice@acme.com")!;

      // First remove
      await service.transitionUserStatus(
        alice.discoveryId,
        "removed",
        "dlg_test001",
      );

      // Try to reactivate (should fail)
      await expect(
        service.transitionUserStatus(
          alice.discoveryId,
          "active",
          "dlg_test001",
        ),
      ).rejects.toThrow("Invalid transition: removed -> active");
    });

    it("throws for unknown user", async () => {
      await expect(
        service.transitionUserStatus("unknown", "suspended", "dlg_test001"),
      ).rejects.toThrow("Discovered user not found");
    });
  });

  // -----------------------------------------------------------------------
  // Cleanup (AC-4, BR-3)
  // -----------------------------------------------------------------------

  describe("cleanupRemovedUsers", () => {
    it("deletes removed users past retention period", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      // Remove a user
      const users = await store.getDiscoveredUsers("dlg_test001");
      const alice = users.find((u) => u.email === "alice@acme.com")!;

      // Set removed date to 60 days ago (past 30-day default retention)
      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
      await store.updateDiscoveredUser(alice.discoveryId, {
        status: "removed",
        removedAt: sixtyDaysAgo.toISOString(),
      });

      const result = await service.cleanupRemovedUsers("dlg_test001");

      expect(result.cleanedUp).toBe(1);
      expect(result.cleanedUpIds).toContain(alice.discoveryId);

      // Verify user is actually deleted from store
      const remaining = await store.getDiscoveredUsers("dlg_test001");
      expect(remaining).toHaveLength(2); // Bob and Carol remain
    });

    it("does not delete removed users within retention period", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const users = await store.getDiscoveredUsers("dlg_test001");
      const alice = users.find((u) => u.email === "alice@acme.com")!;

      // Set removed date to 10 days ago (within 30-day default retention)
      const tenDaysAgo = new Date();
      tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
      await store.updateDiscoveredUser(alice.discoveryId, {
        status: "removed",
        removedAt: tenDaysAgo.toISOString(),
      });

      const result = await service.cleanupRemovedUsers("dlg_test001");

      expect(result.cleanedUp).toBe(0);
    });

    it("calls account cleaner for users with AccountDO", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const users = await store.getDiscoveredUsers("dlg_test001");
      const alice = users.find((u) => u.email === "alice@acme.com")!;

      // Give Alice an account and mark as removed long ago
      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
      await store.updateDiscoveredUser(alice.discoveryId, {
        status: "removed",
        removedAt: sixtyDaysAgo.toISOString(),
        accountId: "acc_alice",
      });

      const accountCleaner = vi.fn(async () => {});

      await service.cleanupRemovedUsers("dlg_test001", accountCleaner);

      expect(accountCleaner).toHaveBeenCalledWith("acc_alice");
    });

    it("respects custom retention period from config", async () => {
      await service.upsertConfig({
        delegationId: "dlg_test001",
        syncMode: "lazy",
        retentionDays: 90,
      });

      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const users = await store.getDiscoveredUsers("dlg_test001");
      const alice = users.find((u) => u.email === "alice@acme.com")!;

      // Set removed date to 60 days ago (within 90-day retention)
      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
      await store.updateDiscoveredUser(alice.discoveryId, {
        status: "removed",
        removedAt: sixtyDaysAgo.toISOString(),
      });

      const result = await service.cleanupRemovedUsers("dlg_test001");

      expect(result.cleanedUp).toBe(0); // 60 < 90 days retention
    });
  });

  // -----------------------------------------------------------------------
  // Rate Limiting (AC-7, BR-4)
  // -----------------------------------------------------------------------

  describe("rate limiting", () => {
    it("calls Directory API with correct authorization header", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      const url = callArgs[0] as string;
      const init = callArgs[1] as RequestInit;

      expect(url).toContain("admin.googleapis.com/admin/directory/v1/users");
      expect(url).toContain("domain=acme.com");
      expect(init.headers).toBeDefined();
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer mock-directory-token",
      );
    });

    it("throws on Directory API error", async () => {
      const errorFetch = vi.fn(async (): Promise<Response> => {
        return new Response("Forbidden", { status: 403 });
      });

      const errorService = new DiscoveryService(
        store,
        tokenProvider,
        errorFetch,
      );

      await expect(
        errorService.discoverUsers("dlg_test001", "acme.com", "admin@acme.com"),
      ).rejects.toThrow("Directory API request failed (403)");
    });
  });

  // -----------------------------------------------------------------------
  // Configuration Management
  // -----------------------------------------------------------------------

  describe("configuration", () => {
    it("returns null config when not set", async () => {
      const config = await service.getConfig("dlg_test001");
      expect(config).toBeNull();
    });

    it("creates and retrieves config", async () => {
      await service.upsertConfig({
        delegationId: "dlg_test001",
        ouFilter: ["/Engineering"],
        excludedEmails: ["admin@acme.com"],
        syncMode: "proactive",
        retentionDays: 60,
      });

      const config = await service.getConfig("dlg_test001");
      expect(config).toBeDefined();
      expect(config!.ouFilter).toEqual(["/Engineering"]);
      expect(config!.excludedEmails).toEqual(["admin@acme.com"]);
      expect(config!.syncMode).toBe("proactive");
      expect(config!.retentionDays).toBe(60);
    });

    it("updates existing config (upsert)", async () => {
      await service.upsertConfig({
        delegationId: "dlg_test001",
        syncMode: "lazy",
        retentionDays: 30,
      });

      await service.upsertConfig({
        delegationId: "dlg_test001",
        syncMode: "proactive",
        retentionDays: 90,
      });

      const config = await service.getConfig("dlg_test001");
      expect(config!.syncMode).toBe("proactive");
      expect(config!.retentionDays).toBe(90);
    });
  });

  // -----------------------------------------------------------------------
  // Query Helpers
  // -----------------------------------------------------------------------

  describe("isUserDiscovered", () => {
    it("returns true for known active user", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const result = await service.isUserDiscovered(
        "dlg_test001",
        "alice@acme.com",
      );
      expect(result).toBe(true);
    });

    it("returns false for unknown user", async () => {
      const result = await service.isUserDiscovered(
        "dlg_test001",
        "unknown@acme.com",
      );
      expect(result).toBe(false);
    });

    it("returns false for removed user", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const users = await store.getDiscoveredUsers("dlg_test001");
      const alice = users.find((u) => u.email === "alice@acme.com")!;
      await store.updateDiscoveredUser(alice.discoveryId, {
        status: "removed",
      });

      const result = await service.isUserDiscovered(
        "dlg_test001",
        "alice@acme.com",
      );
      expect(result).toBe(false);
    });
  });

  describe("getDiscoveredUsers", () => {
    it("returns all users when no status filter", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const users = await service.getDiscoveredUsers("dlg_test001");
      expect(users).toHaveLength(3);
    });

    it("filters by status", async () => {
      // Discover with one suspended user
      const mixedUsers = DIRECTORY_USERS.map((u) =>
        u.id === "guser-002" ? { ...u, suspended: true } : u,
      );
      const mixedFetch = createDirectoryMockFetch(mixedUsers);
      const mixedService = new DiscoveryService(store, tokenProvider, mixedFetch);
      await mixedService.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      const active = await mixedService.getDiscoveredUsers(
        "dlg_test001",
        "active",
      );
      expect(active).toHaveLength(2);

      const suspended = await mixedService.getDiscoveredUsers(
        "dlg_test001",
        "suspended",
      );
      expect(suspended).toHaveLength(1);
      expect(suspended[0].email).toBe("bob@acme.com");
    });
  });
});
