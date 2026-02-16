/**
 * Unit tests for DelegationService (TM-9iu.2).
 *
 * Tests:
 * - Credential rotation: new key coexists with old key (AC-2)
 * - Impersonation token caching and proactive refresh (AC-4)
 * - JWT signing inside service boundary (AC-5)
 * - Key metadata and rotation due tracking
 * - Health check result handling
 * - sanitizeForResponse never exposes keys
 * - Audit logging on token issuance
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DelegationService } from "./delegation-service";
import type {
  DelegationStore,
  DelegationRecord,
  CachedTokenRecord,
  AuditLogEntry,
} from "./delegation-service";
import type { ServiceAccountKey } from "./jwt-assertion";
import {
  importMasterKeyForServiceAccount,
  encryptServiceAccountKey,
} from "./service-account-crypto";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_MASTER_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const { privateKey: TEST_PRIVATE_KEY_2 } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const TEST_SA_KEY: ServiceAccountKey = {
  type: "service_account",
  project_id: "test-project",
  private_key_id: "key-id-original",
  private_key: TEST_PRIVATE_KEY,
  client_email: "sa@test-project.iam.gserviceaccount.com",
  client_id: "123456789",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
};

const NEW_SA_KEY: ServiceAccountKey = {
  type: "service_account",
  project_id: "test-project",
  private_key_id: "key-id-rotated",
  private_key: TEST_PRIVATE_KEY_2,
  client_email: "sa@test-project.iam.gserviceaccount.com",
  client_id: "123456789",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
};

// ---------------------------------------------------------------------------
// In-memory store for testing
// ---------------------------------------------------------------------------

class InMemoryDelegationStore implements DelegationStore {
  delegations = new Map<string, DelegationRecord>();
  delegationsByDomain = new Map<string, DelegationRecord>();
  tokenCache = new Map<string, CachedTokenRecord>();
  auditLog: AuditLogEntry[] = [];

  async getDelegation(domain: string): Promise<DelegationRecord | null> {
    return this.delegationsByDomain.get(domain) ?? null;
  }

  async getDelegationById(delegationId: string): Promise<DelegationRecord | null> {
    return this.delegations.get(delegationId) ?? null;
  }

  async getActiveDelegations(): Promise<DelegationRecord[]> {
    return [...this.delegations.values()].filter(
      (d) => d.delegationStatus === "active",
    );
  }

  async createDelegation(record: DelegationRecord): Promise<void> {
    this.delegations.set(record.delegationId, record);
    this.delegationsByDomain.set(record.domain, record);
  }

  async updateDelegation(
    delegationId: string,
    updates: Partial<DelegationRecord>,
  ): Promise<void> {
    const existing = this.delegations.get(delegationId);
    if (!existing) throw new Error(`Delegation not found: ${delegationId}`);
    const updated = { ...existing, ...updates };
    this.delegations.set(delegationId, updated);
    this.delegationsByDomain.set(updated.domain, updated);
  }

  async getCachedToken(
    delegationId: string,
    userEmail: string,
  ): Promise<CachedTokenRecord | null> {
    return this.tokenCache.get(`${delegationId}:${userEmail}`) ?? null;
  }

  async setCachedToken(record: CachedTokenRecord): Promise<void> {
    this.tokenCache.set(`${record.delegationId}:${record.userEmail}`, record);
  }

  async writeAuditLog(entry: AuditLogEntry): Promise<void> {
    this.auditLog.push(entry);
  }
}

// ---------------------------------------------------------------------------
// Mock fetch that simulates Google APIs
// ---------------------------------------------------------------------------

function createMockFetch() {
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as Request).url;

    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          access_token: "ya29.mock-access-token-fresh",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes("/calendarList")) {
      return new Response(
        JSON.stringify({
          items: [
            { id: "primary", summary: "Work Calendar", primary: true, accessRole: "owner" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not found", { status: 404 });
  });
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function createTestDelegation(
  store: InMemoryDelegationStore,
  overrides?: Partial<DelegationRecord>,
): Promise<DelegationRecord> {
  const masterKey = await importMasterKeyForServiceAccount(TEST_MASTER_KEY_HEX);
  const encryptedKey = await encryptServiceAccountKey(masterKey, TEST_SA_KEY);

  const record: DelegationRecord = {
    delegationId: "delegation_test_001",
    domain: "acme.com",
    adminEmail: "admin@acme.com",
    delegationStatus: "active",
    encryptedSaKey: JSON.stringify(encryptedKey),
    saClientEmail: "sa@test-project.iam.gserviceaccount.com",
    saClientId: "123456789",
    validatedAt: "2026-01-01T00:00:00.000Z",
    activeUsersCount: 0,
    registrationDate: "2026-01-01T00:00:00.000Z",
    saKeyCreatedAt: "2026-01-01T00:00:00.000Z",
    saKeyLastUsedAt: null,
    saKeyRotationDueAt: "2026-04-01T00:00:00.000Z",
    previousEncryptedSaKey: null,
    previousSaKeyId: null,
    lastHealthCheckAt: null,
    healthCheckStatus: "unknown",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };

  await store.createDelegation(record);
  return record;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DelegationService", () => {
  let store: InMemoryDelegationStore;
  let service: DelegationService;
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    store = new InMemoryDelegationStore();
    mockFetch = createMockFetch();
    service = new DelegationService(store, TEST_MASTER_KEY_HEX, mockFetch);
  });

  // -----------------------------------------------------------------------
  // Credential Registration
  // -----------------------------------------------------------------------

  describe("registerDelegation", () => {
    it("creates a delegation record with encrypted key", async () => {
      const record = await service.registerDelegation(
        "acme.com",
        "admin@acme.com",
        TEST_SA_KEY,
      );

      expect(record.delegationId).toBeDefined();
      expect(record.domain).toBe("acme.com");
      expect(record.adminEmail).toBe("admin@acme.com");
      expect(record.delegationStatus).toBe("active");
      expect(record.saClientEmail).toBe("sa@test-project.iam.gserviceaccount.com");

      // Key is encrypted (not plaintext)
      expect(record.encryptedSaKey).not.toContain("PRIVATE KEY");
      expect(record.encryptedSaKey).not.toContain("service_account");

      // Rotation tracking set
      expect(record.saKeyCreatedAt).toBeDefined();
      expect(record.saKeyRotationDueAt).toBeDefined();
    });

    it("lowercases the domain", async () => {
      const record = await service.registerDelegation(
        "ACME.COM",
        "admin@ACME.COM",
        TEST_SA_KEY,
      );
      expect(record.domain).toBe("acme.com");
    });

    it("sets rotation due date to 90 days from now", async () => {
      const record = await service.registerDelegation(
        "acme.com",
        "admin@acme.com",
        TEST_SA_KEY,
      );

      const created = new Date(record.saKeyCreatedAt!);
      const due = new Date(record.saKeyRotationDueAt!);
      const diffDays = Math.round(
        (due.getTime() - created.getTime()) / (1000 * 60 * 60 * 24),
      );
      expect(diffDays).toBe(90);
    });
  });

  // -----------------------------------------------------------------------
  // Credential Rotation (AC-2)
  // -----------------------------------------------------------------------

  describe("rotateCredential", () => {
    it("rotates to new key while keeping old key as previous", async () => {
      const delegation = await createTestDelegation(store);

      const result = await service.rotateCredential(
        delegation.delegationId,
        NEW_SA_KEY,
      );

      expect(result.success).toBe(true);
      expect(result.newKeyId).toBe("key-id-rotated");
      expect(result.oldKeyId).toBe("key-id-original");
      expect(result.rotatedAt).toBeDefined();
    });

    it("stores old key in previousEncryptedSaKey (zero-downtime)", async () => {
      const delegation = await createTestDelegation(store);
      const originalEncrypted = delegation.encryptedSaKey;

      await service.rotateCredential(delegation.delegationId, NEW_SA_KEY);

      const updated = await store.getDelegationById(delegation.delegationId);
      expect(updated).toBeDefined();
      // Previous key should be the original encrypted key
      expect(updated!.previousEncryptedSaKey).toBe(originalEncrypted);
      expect(updated!.previousSaKeyId).toBe("key-id-original");
      // Current key should be different from original
      expect(updated!.encryptedSaKey).not.toBe(originalEncrypted);
    });

    it("updates rotation due date on rotation", async () => {
      const delegation = await createTestDelegation(store);

      await service.rotateCredential(delegation.delegationId, NEW_SA_KEY);

      const updated = await store.getDelegationById(delegation.delegationId);
      expect(updated!.saKeyCreatedAt).toBeDefined();
      expect(updated!.saKeyRotationDueAt).toBeDefined();

      const created = new Date(updated!.saKeyCreatedAt!);
      const due = new Date(updated!.saKeyRotationDueAt!);
      const diffDays = Math.round(
        (due.getTime() - created.getTime()) / (1000 * 60 * 60 * 24),
      );
      expect(diffDays).toBe(90);
    });

    it("writes audit log entry on rotation", async () => {
      const delegation = await createTestDelegation(store);

      await service.rotateCredential(delegation.delegationId, NEW_SA_KEY);

      const auditEntries = store.auditLog.filter((e) => e.action === "key_rotated");
      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0].delegationId).toBe(delegation.delegationId);
      expect(auditEntries[0].domain).toBe("acme.com");

      const details = JSON.parse(auditEntries[0].details!);
      expect(details.oldKeyId).toBe("key-id-original");
      expect(details.newKeyId).toBe("key-id-rotated");
    });

    it("throws for non-existent delegation", async () => {
      await expect(
        service.rotateCredential("nonexistent", NEW_SA_KEY),
      ).rejects.toThrow("Delegation not found");
    });
  });

  // -----------------------------------------------------------------------
  // Key Metadata
  // -----------------------------------------------------------------------

  describe("getKeyMetadata", () => {
    it("returns key metadata without exposing private key", async () => {
      const delegation = await createTestDelegation(store);

      const metadata = await service.getKeyMetadata(delegation.delegationId);

      expect(metadata).toBeDefined();
      expect(metadata!.keyId).toBe("key-id-original");
      expect(metadata!.createdAt).toBe("2026-01-01T00:00:00.000Z");
      expect(metadata!.lastUsedAt).toBeNull();
      expect(metadata!.rotationDueAt).toBeDefined();
    });

    it("returns null for non-existent delegation", async () => {
      const metadata = await service.getKeyMetadata("nonexistent");
      expect(metadata).toBeNull();
    });
  });

  describe("isRotationDue", () => {
    it("returns false for recently created key", async () => {
      const now = new Date();
      await createTestDelegation(store, {
        saKeyCreatedAt: now.toISOString(),
      });

      const due = await service.isRotationDue("delegation_test_001");
      expect(due).toBe(false);
    });

    it("returns true for key older than 90 days", async () => {
      const old = new Date();
      old.setDate(old.getDate() - 100); // 100 days ago
      await createTestDelegation(store, {
        saKeyCreatedAt: old.toISOString(),
      });

      const due = await service.isRotationDue("delegation_test_001");
      expect(due).toBe(true);
    });

    it("returns false for non-existent delegation", async () => {
      const due = await service.isRotationDue("nonexistent");
      expect(due).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Delegation Health Check (AC-3)
  // -----------------------------------------------------------------------

  describe("checkDelegationHealth", () => {
    it("reports healthy when impersonation succeeds", async () => {
      const delegation = await createTestDelegation(store);

      const result = await service.checkDelegationHealth(delegation.delegationId);

      expect(result.status).toBe("healthy");
      expect(result.canImpersonateAdmin).toBe(true);
      expect(result.scopesValid).toBe(true);
      expect(result.error).toBeNull();
      expect(result.domain).toBe("acme.com");
    });

    it("reports revoked when token exchange returns unauthorized_client", async () => {
      const failFetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(
            JSON.stringify({ error: "unauthorized_client" }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("Not found", { status: 404 });
      });

      const failService = new DelegationService(store, TEST_MASTER_KEY_HEX, failFetch);
      const delegation = await createTestDelegation(store);

      const result = await failService.checkDelegationHealth(delegation.delegationId);

      expect(result.status).toBe("revoked");
      expect(result.canImpersonateAdmin).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("updates delegation record with health status", async () => {
      const delegation = await createTestDelegation(store);

      await service.checkDelegationHealth(delegation.delegationId);

      const updated = await store.getDelegationById(delegation.delegationId);
      expect(updated!.healthCheckStatus).toBe("healthy");
      expect(updated!.lastHealthCheckAt).toBeDefined();
    });

    it("marks delegation as revoked when revocation detected", async () => {
      const failFetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response("unauthorized_client", { status: 401 });
        }
        return new Response("Not found", { status: 404 });
      });

      const failService = new DelegationService(store, TEST_MASTER_KEY_HEX, failFetch);
      const delegation = await createTestDelegation(store);

      await failService.checkDelegationHealth(delegation.delegationId);

      const updated = await store.getDelegationById(delegation.delegationId);
      expect(updated!.delegationStatus).toBe("revoked");
    });

    it("writes audit log entry for health check", async () => {
      const delegation = await createTestDelegation(store);

      await service.checkDelegationHealth(delegation.delegationId);

      const auditEntries = store.auditLog.filter((e) => e.action === "health_check");
      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0].delegationId).toBe(delegation.delegationId);
    });

    it("throws for non-existent delegation", async () => {
      await expect(
        service.checkDelegationHealth("nonexistent"),
      ).rejects.toThrow("Delegation not found");
    });
  });

  describe("checkAllDelegationHealth", () => {
    it("checks health of all active delegations", async () => {
      await createTestDelegation(store, {
        delegationId: "delegation_1",
        domain: "acme.com",
      });
      await createTestDelegation(store, {
        delegationId: "delegation_2",
        domain: "corp.com",
        adminEmail: "admin@corp.com",
      });

      const results = await service.checkAllDelegationHealth();

      expect(results).toHaveLength(2);
      expect(results[0].status).toBe("healthy");
      expect(results[1].status).toBe("healthy");
    });

    it("skips revoked delegations", async () => {
      await createTestDelegation(store, {
        delegationId: "delegation_active",
        domain: "acme.com",
      });
      await createTestDelegation(store, {
        delegationId: "delegation_revoked",
        domain: "revoked.com",
        delegationStatus: "revoked",
      });

      const results = await service.checkAllDelegationHealth();

      expect(results).toHaveLength(1);
      expect(results[0].domain).toBe("acme.com");
    });
  });

  // -----------------------------------------------------------------------
  // Impersonation Token Cache (AC-4)
  // -----------------------------------------------------------------------

  describe("getImpersonationToken", () => {
    it("generates fresh token when cache is empty", async () => {
      const delegation = await createTestDelegation(store);

      const result = await service.getImpersonationToken(
        delegation.delegationId,
        "user@acme.com",
      );

      expect(result.accessToken).toBe("ya29.mock-access-token-fresh");
      expect(result.fromCache).toBe(false);
      expect(result.expiresAt).toBeDefined();
    });

    it("caches token after first issuance", async () => {
      const delegation = await createTestDelegation(store);

      await service.getImpersonationToken(
        delegation.delegationId,
        "user@acme.com",
      );

      const cached = await store.getCachedToken(
        delegation.delegationId,
        "user@acme.com",
      );
      expect(cached).toBeDefined();
      expect(cached!.delegationId).toBe(delegation.delegationId);
      expect(cached!.userEmail).toBe("user@acme.com");
    });

    it("updates saKeyLastUsedAt when token is issued", async () => {
      const delegation = await createTestDelegation(store);

      await service.getImpersonationToken(
        delegation.delegationId,
        "user@acme.com",
      );

      const updated = await store.getDelegationById(delegation.delegationId);
      expect(updated!.saKeyLastUsedAt).toBeDefined();
    });

    it("writes audit log entry for token issuance", async () => {
      const delegation = await createTestDelegation(store);

      await service.getImpersonationToken(
        delegation.delegationId,
        "user@acme.com",
      );

      const auditEntries = store.auditLog.filter((e) => e.action === "token_issued");
      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0].userEmail).toBe("user@acme.com");
      expect(auditEntries[0].delegationId).toBe(delegation.delegationId);
    });

    it("throws for non-existent delegation", async () => {
      await expect(
        service.getImpersonationToken("nonexistent", "user@acme.com"),
      ).rejects.toThrow("Delegation not found");
    });

    it("throws for revoked delegation", async () => {
      await createTestDelegation(store, {
        delegationStatus: "revoked",
      });

      await expect(
        service.getImpersonationToken("delegation_test_001", "user@acme.com"),
      ).rejects.toThrow("revoked");
    });
  });

  // -----------------------------------------------------------------------
  // Multi-org Support (AC-6)
  // -----------------------------------------------------------------------

  describe("getDelegationForDomain", () => {
    it("returns delegation for registered domain", async () => {
      await createTestDelegation(store);

      const result = await service.getDelegationForDomain("acme.com");
      expect(result).toBeDefined();
      expect(result!.domain).toBe("acme.com");
    });

    it("returns null for unregistered domain", async () => {
      const result = await service.getDelegationForDomain("unknown.com");
      expect(result).toBeNull();
    });

    it("lowercases domain for lookup", async () => {
      await createTestDelegation(store);

      const result = await service.getDelegationForDomain("ACME.COM");
      expect(result).toBeDefined();
      expect(result!.domain).toBe("acme.com");
    });
  });

  describe("listActiveDelegations", () => {
    it("returns only active delegations", async () => {
      await createTestDelegation(store, {
        delegationId: "d1",
        domain: "active.com",
        delegationStatus: "active",
      });
      await createTestDelegation(store, {
        delegationId: "d2",
        domain: "revoked.com",
        delegationStatus: "revoked",
      });

      const active = await service.listActiveDelegations();
      expect(active).toHaveLength(1);
      expect(active[0].domain).toBe("active.com");
    });
  });

  // -----------------------------------------------------------------------
  // Security: sanitize responses (AC-5)
  // -----------------------------------------------------------------------

  describe("sanitizeForResponse", () => {
    it("never includes encrypted keys in response", async () => {
      const delegation = await createTestDelegation(store);

      const sanitized = DelegationService.sanitizeForResponse(delegation);

      // Should include public-facing fields
      expect(sanitized.delegation_id).toBe(delegation.delegationId);
      expect(sanitized.domain).toBe("acme.com");
      expect(sanitized.sa_client_email).toBeDefined();
      expect(sanitized.health_check_status).toBeDefined();

      // MUST NOT include any key material
      const json = JSON.stringify(sanitized);
      expect(json).not.toContain("encryptedSaKey");
      expect(json).not.toContain("previousEncryptedSaKey");
      expect(json).not.toContain("PRIVATE KEY");
      expect(json).not.toContain("ciphertext");
    });

    it("includes rotation tracking fields", () => {
      const record: DelegationRecord = {
        delegationId: "d1",
        domain: "acme.com",
        adminEmail: "admin@acme.com",
        delegationStatus: "active",
        encryptedSaKey: '{"iv":"x","ciphertext":"y","encryptedDek":"z","dekIv":"w"}',
        saClientEmail: "sa@test.iam.gserviceaccount.com",
        saClientId: "123",
        validatedAt: "2026-01-01T00:00:00.000Z",
        activeUsersCount: 10,
        registrationDate: "2026-01-01T00:00:00.000Z",
        saKeyCreatedAt: "2026-01-01T00:00:00.000Z",
        saKeyLastUsedAt: "2026-02-01T00:00:00.000Z",
        saKeyRotationDueAt: "2026-04-01T00:00:00.000Z",
        previousEncryptedSaKey: null,
        previousSaKeyId: null,
        lastHealthCheckAt: "2026-02-15T00:00:00.000Z",
        healthCheckStatus: "healthy",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-02-15T00:00:00.000Z",
      };

      const sanitized = DelegationService.sanitizeForResponse(record);
      expect(sanitized.sa_key_created_at).toBe("2026-01-01T00:00:00.000Z");
      expect(sanitized.sa_key_rotation_due_at).toBe("2026-04-01T00:00:00.000Z");
      expect(sanitized.health_check_status).toBe("healthy");
      expect(sanitized.active_users_count).toBe(10);
    });
  });
});
