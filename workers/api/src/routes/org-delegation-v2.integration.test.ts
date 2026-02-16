/**
 * Integration tests for delegation infrastructure (TM-9iu.2).
 *
 * Tests the full delegation lifecycle against real SQLite (via better-sqlite3):
 * 1. Multi-org: 2+ domains with independent delegation configurations
 * 2. Credential rotation: new key coexists with old, zero-downtime
 * 3. Delegation health check: detects revoked delegation
 * 4. Impersonation token caching: proactive refresh
 * 5. Key never exposed: API responses never contain encrypted keys
 * 6. Zod schema validation on decrypt round-trip
 * 7. Audit logging for all impersonation events
 *
 * Uses real SQLite via better-sqlite3 with all migrations applied.
 * Google API calls are mocked via injectable fetchFn.
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  MIGRATION_0001_INITIAL_SCHEMA,
  MIGRATION_0004_AUTH_FIELDS,
  MIGRATION_0022_ORG_DELEGATIONS,
  MIGRATION_0023_DELEGATION_INFRASTRUCTURE,
  MIGRATION_0024_DELEGATION_CACHE_AND_AUDIT,
} from "@tminus/d1-registry";
import {
  DelegationService,
  importMasterKeyForServiceAccount,
  encryptServiceAccountKey,
  decryptServiceAccountKey,
  parseServiceAccountKey,
  parseEncryptedEnvelope,
  generateId,
} from "@tminus/shared";
import type {
  DelegationStore,
  DelegationRecord,
  CachedTokenRecord,
  AuditLogEntry,
  ServiceAccountKey,
} from "@tminus/shared";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { privateKey: KEY_1 } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const { privateKey: KEY_2 } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const SA_KEY_1: ServiceAccountKey = {
  type: "service_account",
  project_id: "tminus-test",
  private_key_id: "key-alpha",
  private_key: KEY_1,
  client_email: "sa@tminus-test.iam.gserviceaccount.com",
  client_id: "111111111111",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
};

const SA_KEY_2: ServiceAccountKey = {
  type: "service_account",
  project_id: "tminus-test",
  private_key_id: "key-beta",
  private_key: KEY_2,
  client_email: "sa@tminus-test.iam.gserviceaccount.com",
  client_id: "111111111111",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
};

// ---------------------------------------------------------------------------
// D1-backed DelegationStore implementation (production-like)
// ---------------------------------------------------------------------------

class D1DelegationStore implements DelegationStore {
  constructor(private readonly db: DatabaseType) {}

  async getDelegation(domain: string): Promise<DelegationRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM org_delegations WHERE domain = ?")
      .get(domain) as Record<string, unknown> | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  async getDelegationById(delegationId: string): Promise<DelegationRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM org_delegations WHERE delegation_id = ?")
      .get(delegationId) as Record<string, unknown> | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  async getActiveDelegations(): Promise<DelegationRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM org_delegations WHERE delegation_status = 'active'")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToRecord(r));
  }

  async createDelegation(record: DelegationRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO org_delegations
         (delegation_id, domain, admin_email, delegation_status, encrypted_sa_key,
          sa_client_email, sa_client_id, validated_at, active_users_count,
          registration_date, sa_key_created_at, sa_key_last_used_at,
          sa_key_rotation_due_at, previous_encrypted_sa_key, previous_sa_key_id,
          last_health_check_at, health_check_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.delegationId,
        record.domain,
        record.adminEmail,
        record.delegationStatus,
        record.encryptedSaKey,
        record.saClientEmail,
        record.saClientId,
        record.validatedAt,
        record.activeUsersCount,
        record.registrationDate,
        record.saKeyCreatedAt,
        record.saKeyLastUsedAt,
        record.saKeyRotationDueAt,
        record.previousEncryptedSaKey,
        record.previousSaKeyId,
        record.lastHealthCheckAt,
        record.healthCheckStatus,
        record.createdAt,
        record.updatedAt,
      );
  }

  async updateDelegation(
    delegationId: string,
    updates: Partial<DelegationRecord>,
  ): Promise<void> {
    // Build dynamic UPDATE
    const sets: string[] = [];
    const values: unknown[] = [];

    const fieldMap: Record<string, string> = {
      encryptedSaKey: "encrypted_sa_key",
      saClientEmail: "sa_client_email",
      saClientId: "sa_client_id",
      delegationStatus: "delegation_status",
      previousEncryptedSaKey: "previous_encrypted_sa_key",
      previousSaKeyId: "previous_sa_key_id",
      saKeyCreatedAt: "sa_key_created_at",
      saKeyLastUsedAt: "sa_key_last_used_at",
      saKeyRotationDueAt: "sa_key_rotation_due_at",
      lastHealthCheckAt: "last_health_check_at",
      healthCheckStatus: "health_check_status",
      updatedAt: "updated_at",
      activeUsersCount: "active_users_count",
      validatedAt: "validated_at",
    };

    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in updates) {
        sets.push(`${col} = ?`);
        values.push((updates as Record<string, unknown>)[key]);
      }
    }

    if (sets.length === 0) return;

    values.push(delegationId);
    this.db
      .prepare(
        `UPDATE org_delegations SET ${sets.join(", ")} WHERE delegation_id = ?`,
      )
      .run(...values);
  }

  async getCachedToken(
    delegationId: string,
    userEmail: string,
  ): Promise<CachedTokenRecord | null> {
    const row = this.db
      .prepare(
        "SELECT * FROM impersonation_token_cache WHERE delegation_id = ? AND user_email = ?",
      )
      .get(delegationId, userEmail) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      cacheId: row.cache_id as string,
      delegationId: row.delegation_id as string,
      userEmail: row.user_email as string,
      encryptedToken: row.encrypted_token as string,
      tokenExpiresAt: row.token_expires_at as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  async setCachedToken(record: CachedTokenRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO impersonation_token_cache
         (cache_id, delegation_id, user_email, encrypted_token, token_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.cacheId,
        record.delegationId,
        record.userEmail,
        record.encryptedToken,
        record.tokenExpiresAt,
        record.createdAt,
        record.updatedAt,
      );
  }

  async writeAuditLog(entry: AuditLogEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO delegation_audit_log
         (audit_id, delegation_id, domain, user_email, action, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.auditId,
        entry.delegationId,
        entry.domain,
        entry.userEmail,
        entry.action,
        entry.details,
        entry.createdAt,
      );
  }

  private rowToRecord(row: Record<string, unknown>): DelegationRecord {
    return {
      delegationId: row.delegation_id as string,
      domain: row.domain as string,
      adminEmail: row.admin_email as string,
      delegationStatus: row.delegation_status as "pending" | "active" | "revoked",
      encryptedSaKey: row.encrypted_sa_key as string,
      saClientEmail: row.sa_client_email as string,
      saClientId: row.sa_client_id as string,
      validatedAt: row.validated_at as string | null,
      activeUsersCount: (row.active_users_count as number) ?? 0,
      registrationDate: row.registration_date as string | null,
      saKeyCreatedAt: row.sa_key_created_at as string | null,
      saKeyLastUsedAt: row.sa_key_last_used_at as string | null,
      saKeyRotationDueAt: row.sa_key_rotation_due_at as string | null,
      previousEncryptedSaKey: row.previous_encrypted_sa_key as string | null,
      previousSaKeyId: row.previous_sa_key_id as string | null,
      lastHealthCheckAt: row.last_health_check_at as string | null,
      healthCheckStatus: (row.health_check_status as "healthy" | "degraded" | "revoked" | "unknown") ?? "unknown",
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

function createSuccessFetch() {
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as Request).url;

    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          access_token: "ya29.integration-test-token",
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

function createRevokedFetch() {
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as Request).url;

    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          error: "unauthorized_client",
          error_description: "Client is unauthorized",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not found", { status: 404 });
  });
}

// ---------------------------------------------------------------------------
// Apply migrations helper
// ---------------------------------------------------------------------------

function applyMigrations(db: DatabaseType): void {
  db.exec(MIGRATION_0001_INITIAL_SCHEMA);
  // Apply ALTER TABLE statements one at a time (SQLite requirement)
  const alterStatements = MIGRATION_0004_AUTH_FIELDS.trim().split(";").filter(Boolean);
  for (const stmt of alterStatements) {
    db.exec(stmt.trim() + ";");
  }
  db.exec(MIGRATION_0022_ORG_DELEGATIONS);
  // Migration 0023: ALTER TABLE statements
  const infraStatements = MIGRATION_0023_DELEGATION_INFRASTRUCTURE.trim().split(";").filter(Boolean);
  for (const stmt of infraStatements) {
    db.exec(stmt.trim() + ";");
  }
  db.exec(MIGRATION_0024_DELEGATION_CACHE_AND_AUDIT);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("delegation infrastructure integration (TM-9iu.2)", () => {
  let db: DatabaseType;
  let store: D1DelegationStore;
  let service: DelegationService;
  let mockFetch: ReturnType<typeof createSuccessFetch>;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    store = new D1DelegationStore(db);
    mockFetch = createSuccessFetch();
    service = new DelegationService(store, TEST_MASTER_KEY, mockFetch);
  });

  // -----------------------------------------------------------------------
  // Multi-org support with 2+ domains (AC-6)
  // -----------------------------------------------------------------------

  describe("multi-org support", () => {
    it("supports 2+ independent Workspace domains", async () => {
      // Register two different orgs
      const org1 = await service.registerDelegation(
        "acme.com",
        "admin@acme.com",
        SA_KEY_1,
      );
      const org2 = await service.registerDelegation(
        "globex.com",
        "admin@globex.com",
        SA_KEY_2,
      );

      // Verify both exist independently
      expect(org1.domain).toBe("acme.com");
      expect(org2.domain).toBe("globex.com");
      expect(org1.delegationId).not.toBe(org2.delegationId);

      // Both stored in DB
      const row1 = db
        .prepare("SELECT * FROM org_delegations WHERE domain = ?")
        .get("acme.com") as Record<string, unknown>;
      const row2 = db
        .prepare("SELECT * FROM org_delegations WHERE domain = ?")
        .get("globex.com") as Record<string, unknown>;

      expect(row1).toBeDefined();
      expect(row2).toBeDefined();
      expect(row1.delegation_id).not.toBe(row2.delegation_id);
    });

    it("each domain has independent delegation config", async () => {
      await service.registerDelegation("acme.com", "admin@acme.com", SA_KEY_1);
      await service.registerDelegation("globex.com", "admin@globex.com", SA_KEY_2);

      const acme = await service.getDelegationForDomain("acme.com");
      const globex = await service.getDelegationForDomain("globex.com");

      expect(acme!.saClientEmail).toBe("sa@tminus-test.iam.gserviceaccount.com");
      expect(globex!.saClientEmail).toBe("sa@tminus-test.iam.gserviceaccount.com");

      // Different encrypted keys (different RSA keys + random DEK)
      expect(acme!.encryptedSaKey).not.toBe(globex!.encryptedSaKey);
    });

    it("listActiveDelegations returns all active orgs", async () => {
      await service.registerDelegation("acme.com", "admin@acme.com", SA_KEY_1);
      await service.registerDelegation("globex.com", "admin@globex.com", SA_KEY_2);

      const active = await service.listActiveDelegations();
      expect(active).toHaveLength(2);

      const domains = active.map((d) => d.domain).sort();
      expect(domains).toEqual(["acme.com", "globex.com"]);
    });

    it("org record includes registration_date and active_users_count", async () => {
      const org = await service.registerDelegation(
        "acme.com",
        "admin@acme.com",
        SA_KEY_1,
      );

      const row = db
        .prepare("SELECT * FROM org_delegations WHERE domain = ?")
        .get("acme.com") as Record<string, unknown>;

      expect(row.registration_date).toBeDefined();
      expect(row.active_users_count).toBe(0);
      expect(row.admin_email).toBe("admin@acme.com");
    });
  });

  // -----------------------------------------------------------------------
  // Credential rotation (AC-2)
  // -----------------------------------------------------------------------

  describe("credential rotation", () => {
    it("zero-downtime: old key preserved during transition", async () => {
      const org = await service.registerDelegation(
        "acme.com",
        "admin@acme.com",
        SA_KEY_1,
      );

      const result = await service.rotateCredential(org.delegationId, SA_KEY_2);

      expect(result.success).toBe(true);
      expect(result.oldKeyId).toBe("key-alpha");
      expect(result.newKeyId).toBe("key-beta");

      // DB has both current and previous keys
      const row = db
        .prepare("SELECT * FROM org_delegations WHERE delegation_id = ?")
        .get(org.delegationId) as Record<string, unknown>;

      expect(row.encrypted_sa_key).toBeDefined();
      expect(row.previous_encrypted_sa_key).toBeDefined();
      expect(row.previous_sa_key_id).toBe("key-alpha");
    });

    it("current key is different from previous after rotation", async () => {
      const org = await service.registerDelegation(
        "acme.com",
        "admin@acme.com",
        SA_KEY_1,
      );

      await service.rotateCredential(org.delegationId, SA_KEY_2);

      const row = db
        .prepare("SELECT encrypted_sa_key, previous_encrypted_sa_key FROM org_delegations WHERE delegation_id = ?")
        .get(org.delegationId) as Record<string, unknown>;

      expect(row.encrypted_sa_key).not.toBe(row.previous_encrypted_sa_key);
    });

    it("decrypted new key matches rotated key material", async () => {
      const org = await service.registerDelegation(
        "acme.com",
        "admin@acme.com",
        SA_KEY_1,
      );

      await service.rotateCredential(org.delegationId, SA_KEY_2);

      // Verify the new key decrypts correctly
      const row = db
        .prepare("SELECT encrypted_sa_key FROM org_delegations WHERE delegation_id = ?")
        .get(org.delegationId) as Record<string, unknown>;

      const masterKey = await importMasterKeyForServiceAccount(TEST_MASTER_KEY);
      const envelope = parseEncryptedEnvelope(JSON.parse(row.encrypted_sa_key as string));
      const decryptedKey = await decryptServiceAccountKey(masterKey, envelope);

      // Validate with Zod (catches schema drift)
      const validated = parseServiceAccountKey(decryptedKey);
      expect(validated.private_key_id).toBe("key-beta");
    });

    it("audit log records rotation event", async () => {
      const org = await service.registerDelegation(
        "acme.com",
        "admin@acme.com",
        SA_KEY_1,
      );

      await service.rotateCredential(org.delegationId, SA_KEY_2);

      const auditRows = db
        .prepare("SELECT * FROM delegation_audit_log WHERE action = 'key_rotated'")
        .all() as Record<string, unknown>[];

      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].delegation_id).toBe(org.delegationId);
      expect(auditRows[0].domain).toBe("acme.com");

      const details = JSON.parse(auditRows[0].details as string);
      expect(details.oldKeyId).toBe("key-alpha");
      expect(details.newKeyId).toBe("key-beta");
    });

    it("rotation updates sa_key_rotation_due_at to 90 days from now", async () => {
      const org = await service.registerDelegation(
        "acme.com",
        "admin@acme.com",
        SA_KEY_1,
      );

      await service.rotateCredential(org.delegationId, SA_KEY_2);

      const row = db
        .prepare("SELECT sa_key_created_at, sa_key_rotation_due_at FROM org_delegations WHERE delegation_id = ?")
        .get(org.delegationId) as Record<string, unknown>;

      const created = new Date(row.sa_key_created_at as string);
      const due = new Date(row.sa_key_rotation_due_at as string);
      const diffDays = Math.round(
        (due.getTime() - created.getTime()) / (1000 * 60 * 60 * 24),
      );
      expect(diffDays).toBe(90);
    });
  });

  // -----------------------------------------------------------------------
  // Delegation health check (AC-3)
  // -----------------------------------------------------------------------

  describe("delegation health check", () => {
    it("detects healthy delegation", async () => {
      const org = await service.registerDelegation(
        "acme.com",
        "admin@acme.com",
        SA_KEY_1,
      );

      const result = await service.checkDelegationHealth(org.delegationId);

      expect(result.status).toBe("healthy");
      expect(result.canImpersonateAdmin).toBe(true);
      expect(result.scopesValid).toBe(true);
      expect(result.error).toBeNull();
    });

    it("detects revoked delegation and updates status", async () => {
      const revokedFetch = createRevokedFetch();
      const revokedService = new DelegationService(store, TEST_MASTER_KEY, revokedFetch);

      const org = await service.registerDelegation(
        "acme.com",
        "admin@acme.com",
        SA_KEY_1,
      );

      const result = await revokedService.checkDelegationHealth(org.delegationId);

      expect(result.status).toBe("revoked");
      expect(result.canImpersonateAdmin).toBe(false);
      expect(result.error).toBeDefined();

      // DB reflects the revoked status
      const row = db
        .prepare("SELECT delegation_status, health_check_status, last_health_check_at FROM org_delegations WHERE delegation_id = ?")
        .get(org.delegationId) as Record<string, unknown>;

      expect(row.delegation_status).toBe("revoked");
      expect(row.health_check_status).toBe("revoked");
      expect(row.last_health_check_at).toBeDefined();
    });

    it("audit log records health check", async () => {
      const org = await service.registerDelegation(
        "acme.com",
        "admin@acme.com",
        SA_KEY_1,
      );

      await service.checkDelegationHealth(org.delegationId);

      const auditRows = db
        .prepare("SELECT * FROM delegation_audit_log WHERE action = 'health_check'")
        .all() as Record<string, unknown>[];

      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].delegation_id).toBe(org.delegationId);

      const details = JSON.parse(auditRows[0].details as string);
      expect(details.status).toBe("healthy");
      expect(details.canImpersonateAdmin).toBe(true);
    });

    it("checkAllDelegationHealth processes all active delegations", async () => {
      await service.registerDelegation("acme.com", "admin@acme.com", SA_KEY_1);
      await service.registerDelegation("globex.com", "admin@globex.com", SA_KEY_2);

      const results = await service.checkAllDelegationHealth();

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === "healthy")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Impersonation token caching (AC-4)
  // -----------------------------------------------------------------------

  describe("impersonation token caching", () => {
    it("issues token and stores in cache", async () => {
      const org = await service.registerDelegation(
        "acme.com",
        "admin@acme.com",
        SA_KEY_1,
      );

      const result = await service.getImpersonationToken(
        org.delegationId,
        "user@acme.com",
      );

      expect(result.accessToken).toBe("ya29.integration-test-token");
      expect(result.fromCache).toBe(false);
      expect(result.expiresAt).toBeDefined();

      // Verify token is cached in DB
      const cacheRow = db
        .prepare(
          "SELECT * FROM impersonation_token_cache WHERE delegation_id = ? AND user_email = ?",
        )
        .get(org.delegationId, "user@acme.com") as Record<string, unknown>;

      expect(cacheRow).toBeDefined();
      expect(cacheRow.encrypted_token).toBeDefined();
      // Token should be encrypted, not plaintext
      expect(cacheRow.encrypted_token as string).not.toContain("ya29");
    });

    it("audit log records token issuance", async () => {
      const org = await service.registerDelegation(
        "acme.com",
        "admin@acme.com",
        SA_KEY_1,
      );

      await service.getImpersonationToken(org.delegationId, "user@acme.com");

      const auditRows = db
        .prepare("SELECT * FROM delegation_audit_log WHERE action = 'token_issued'")
        .all() as Record<string, unknown>[];

      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].user_email).toBe("user@acme.com");
      expect(auditRows[0].domain).toBe("acme.com");
    });

    it("updates sa_key_last_used_at on token issuance", async () => {
      const org = await service.registerDelegation(
        "acme.com",
        "admin@acme.com",
        SA_KEY_1,
      );

      await service.getImpersonationToken(org.delegationId, "user@acme.com");

      const row = db
        .prepare("SELECT sa_key_last_used_at FROM org_delegations WHERE delegation_id = ?")
        .get(org.delegationId) as Record<string, unknown>;

      expect(row.sa_key_last_used_at).toBeDefined();
    });

    it("rejects token request for revoked delegation", async () => {
      const org = await service.registerDelegation(
        "acme.com",
        "admin@acme.com",
        SA_KEY_1,
      );

      // Manually revoke
      db.prepare(
        "UPDATE org_delegations SET delegation_status = 'revoked' WHERE delegation_id = ?",
      ).run(org.delegationId);

      // Re-create service to pick up the revoked state
      const freshService = new DelegationService(store, TEST_MASTER_KEY, mockFetch);

      await expect(
        freshService.getImpersonationToken(org.delegationId, "user@acme.com"),
      ).rejects.toThrow("revoked");
    });
  });

  // -----------------------------------------------------------------------
  // Service account key never exposed in responses (AC-5)
  // -----------------------------------------------------------------------

  describe("key never exposed", () => {
    it("sanitizeForResponse excludes all key material", async () => {
      const org = await service.registerDelegation(
        "acme.com",
        "admin@acme.com",
        SA_KEY_1,
      );

      const sanitized = DelegationService.sanitizeForResponse(org);
      const json = JSON.stringify(sanitized);

      // Must NOT contain any key-related data
      expect(json).not.toContain("PRIVATE KEY");
      expect(json).not.toContain("ciphertext");
      expect(json).not.toContain("encryptedDek");
      expect(json).not.toContain("encryptedSaKey");
      expect(json).not.toContain("previousEncryptedSaKey");

      // MUST contain safe public fields
      expect(sanitized.delegation_id).toBe(org.delegationId);
      expect(sanitized.domain).toBe("acme.com");
      expect(sanitized.sa_client_email).toBe("sa@tminus-test.iam.gserviceaccount.com");
      expect(sanitized.delegation_status).toBe("active");
    });

    it("encrypted key in DB is not plaintext", async () => {
      await service.registerDelegation("acme.com", "admin@acme.com", SA_KEY_1);

      const row = db
        .prepare("SELECT encrypted_sa_key FROM org_delegations WHERE domain = ?")
        .get("acme.com") as Record<string, unknown>;

      const encrypted = row.encrypted_sa_key as string;
      expect(encrypted).not.toContain("PRIVATE KEY");
      expect(encrypted).not.toContain("service_account");
      expect(encrypted).not.toContain(SA_KEY_1.project_id);

      // Verify it IS a valid encrypted envelope
      const envelope = JSON.parse(encrypted);
      expect(envelope.iv).toBeDefined();
      expect(envelope.ciphertext).toBeDefined();
      expect(envelope.encryptedDek).toBeDefined();
      expect(envelope.dekIv).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Zod validation on round-trip (story note)
  // -----------------------------------------------------------------------

  describe("Zod validation on encrypt/decrypt round-trip", () => {
    it("validates structure after decryption with Zod", async () => {
      const org = await service.registerDelegation(
        "acme.com",
        "admin@acme.com",
        SA_KEY_1,
      );

      // Get encrypted key from DB
      const row = db
        .prepare("SELECT encrypted_sa_key FROM org_delegations WHERE delegation_id = ?")
        .get(org.delegationId) as Record<string, unknown>;

      // Decrypt
      const masterKey = await importMasterKeyForServiceAccount(TEST_MASTER_KEY);
      const envelope = parseEncryptedEnvelope(JSON.parse(row.encrypted_sa_key as string));
      const decrypted = await decryptServiceAccountKey(masterKey, envelope);

      // Validate with Zod
      const validated = parseServiceAccountKey(decrypted);
      expect(validated.type).toBe("service_account");
      expect(validated.project_id).toBe("tminus-test");
      expect(validated.private_key_id).toBe("key-alpha");
      expect(validated.client_email).toBe("sa@tminus-test.iam.gserviceaccount.com");
    });
  });

  // -----------------------------------------------------------------------
  // Migration correctness
  // -----------------------------------------------------------------------

  describe("migration 0023 + 0024 columns exist", () => {
    it("org_delegations has all TM-9iu.2 columns", () => {
      const columns = db
        .prepare("PRAGMA table_info(org_delegations)")
        .all() as Array<{ name: string }>;
      const names = columns.map((c) => c.name);

      expect(names).toContain("active_users_count");
      expect(names).toContain("registration_date");
      expect(names).toContain("sa_key_created_at");
      expect(names).toContain("sa_key_last_used_at");
      expect(names).toContain("sa_key_rotation_due_at");
      expect(names).toContain("previous_encrypted_sa_key");
      expect(names).toContain("previous_sa_key_id");
      expect(names).toContain("last_health_check_at");
      expect(names).toContain("health_check_status");
    });

    it("impersonation_token_cache table exists with correct schema", () => {
      const columns = db
        .prepare("PRAGMA table_info(impersonation_token_cache)")
        .all() as Array<{ name: string }>;
      const names = columns.map((c) => c.name);

      expect(names).toContain("cache_id");
      expect(names).toContain("delegation_id");
      expect(names).toContain("user_email");
      expect(names).toContain("encrypted_token");
      expect(names).toContain("token_expires_at");
    });

    it("delegation_audit_log table exists with correct schema", () => {
      const columns = db
        .prepare("PRAGMA table_info(delegation_audit_log)")
        .all() as Array<{ name: string }>;
      const names = columns.map((c) => c.name);

      expect(names).toContain("audit_id");
      expect(names).toContain("delegation_id");
      expect(names).toContain("domain");
      expect(names).toContain("user_email");
      expect(names).toContain("action");
      expect(names).toContain("details");
    });
  });
});
