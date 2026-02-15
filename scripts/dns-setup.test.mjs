/**
 * Tests for dns-setup.mjs -- DNS record configuration, argument parsing,
 * CNAME record generation, idempotency logic, and dry-run behavior.
 *
 * These tests require NO Cloudflare credentials or network access.
 * They verify DNS record configuration, CLI argument parsing, and
 * the pure logic of record generation and idempotency checks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseDnsArgs,
  DNS_RECORDS,
  SUBDOMAINS,
  CNAME_TARGET,
  CLOUDFLARE_API_BASE,
  VALID_ENVIRONMENTS,
  buildDnsRecords,
  getRecordsForEnvironment,
  ensureProxiedRecord,
  ensureDnsRecords,
  ensureAllDnsRecords,
  getAuthHeaders,
  cfRequest,
} from "./dns-setup.mjs";

// ---------------------------------------------------------------------------
// parseDnsArgs
// ---------------------------------------------------------------------------

describe("parseDnsArgs", () => {
  it("returns defaults when no args", () => {
    expect(parseDnsArgs([])).toEqual({
      dryRun: false,
      verbose: false,
      environment: "production",
    });
  });

  it("detects --dry-run", () => {
    expect(parseDnsArgs(["--dry-run"]).dryRun).toBe(true);
  });

  it("detects --verbose and -v", () => {
    expect(parseDnsArgs(["--verbose"]).verbose).toBe(true);
    expect(parseDnsArgs(["-v"]).verbose).toBe(true);
  });

  it("detects --env production", () => {
    expect(parseDnsArgs(["--env", "production"]).environment).toBe(
      "production"
    );
  });

  it("detects --env staging", () => {
    expect(parseDnsArgs(["--env", "staging"]).environment).toBe("staging");
  });

  it("detects --env all", () => {
    expect(parseDnsArgs(["--env", "all"]).environment).toBe("all");
  });

  it("handles multiple flags", () => {
    const result = parseDnsArgs(["--dry-run", "-v", "--env", "staging"]);
    expect(result).toEqual({
      dryRun: true,
      verbose: true,
      environment: "staging",
    });
  });

  it("ignores unknown flags gracefully", () => {
    const result = parseDnsArgs(["--unknown", "--dry-run"]);
    expect(result.dryRun).toBe(true);
    expect(result.environment).toBe("production");
  });

  it("defaults environment to production when --env has no value", () => {
    // --env at the end with no following arg
    const result = parseDnsArgs(["--env"]);
    expect(result.environment).toBe("production");
  });
});

// ---------------------------------------------------------------------------
// VALID_ENVIRONMENTS
// ---------------------------------------------------------------------------

describe("VALID_ENVIRONMENTS", () => {
  it("includes production, staging, and all", () => {
    expect(VALID_ENVIRONMENTS).toContain("production");
    expect(VALID_ENVIRONMENTS).toContain("staging");
    expect(VALID_ENVIRONMENTS).toContain("all");
  });

  it("has exactly 3 entries", () => {
    expect(VALID_ENVIRONMENTS).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// SUBDOMAINS
// ---------------------------------------------------------------------------

describe("SUBDOMAINS", () => {
  it("contains exactly api, app, mcp, webhooks, oauth", () => {
    expect(SUBDOMAINS).toEqual(["api", "app", "mcp", "webhooks", "oauth"]);
  });

  it("has 5 subdomains", () => {
    expect(SUBDOMAINS).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// CNAME_TARGET
// ---------------------------------------------------------------------------

describe("CNAME_TARGET", () => {
  it("points to tminus.ink", () => {
    expect(CNAME_TARGET).toBe("tminus.ink");
  });
});

// ---------------------------------------------------------------------------
// DNS_RECORDS configuration
// ---------------------------------------------------------------------------

describe("DNS_RECORDS", () => {
  it("has production and staging environments", () => {
    expect(DNS_RECORDS).toHaveProperty("production");
    expect(DNS_RECORDS).toHaveProperty("staging");
  });

  it("production includes all 5 subdomains", () => {
    expect(DNS_RECORDS.production).toContain("api.tminus.ink");
    expect(DNS_RECORDS.production).toContain("app.tminus.ink");
    expect(DNS_RECORDS.production).toContain("mcp.tminus.ink");
    expect(DNS_RECORDS.production).toContain("webhooks.tminus.ink");
    expect(DNS_RECORDS.production).toContain("oauth.tminus.ink");
    expect(DNS_RECORDS.production).toHaveLength(5);
  });

  it("staging includes all 5 subdomains with -staging suffix", () => {
    expect(DNS_RECORDS.staging).toContain("api-staging.tminus.ink");
    expect(DNS_RECORDS.staging).toContain("app-staging.tminus.ink");
    expect(DNS_RECORDS.staging).toContain("mcp-staging.tminus.ink");
    expect(DNS_RECORDS.staging).toContain("webhooks-staging.tminus.ink");
    expect(DNS_RECORDS.staging).toContain("oauth-staging.tminus.ink");
    expect(DNS_RECORDS.staging).toHaveLength(5);
  });

  it("production hostnames are under tminus.ink", () => {
    for (const hostname of DNS_RECORDS.production) {
      expect(hostname.endsWith(".tminus.ink")).toBe(true);
    }
  });

  it("staging hostnames are under tminus.ink", () => {
    for (const hostname of DNS_RECORDS.staging) {
      expect(hostname.endsWith(".tminus.ink")).toBe(true);
    }
  });

  it("production and staging have no overlapping hostnames", () => {
    const prodSet = new Set(DNS_RECORDS.production);
    for (const hostname of DNS_RECORDS.staging) {
      expect(prodSet.has(hostname)).toBe(false);
    }
  });

  it("staging hostnames contain -staging before .tminus.ink", () => {
    for (const hostname of DNS_RECORDS.staging) {
      expect(hostname).toMatch(/-staging\.tminus\.ink$/);
    }
  });

  it("production hostnames do NOT contain -staging", () => {
    for (const hostname of DNS_RECORDS.production) {
      expect(hostname).not.toContain("-staging");
    }
  });
});

// ---------------------------------------------------------------------------
// buildDnsRecords
// ---------------------------------------------------------------------------

describe("buildDnsRecords", () => {
  it("returns 5 records for production", () => {
    const records = buildDnsRecords("production");
    expect(records).toHaveLength(5);
  });

  it("returns 5 records for staging", () => {
    const records = buildDnsRecords("staging");
    expect(records).toHaveLength(5);
  });

  it("production records have correct names", () => {
    const records = buildDnsRecords("production");
    const names = records.map((r) => r.name);
    expect(names).toEqual([
      "api.tminus.ink",
      "app.tminus.ink",
      "mcp.tminus.ink",
      "webhooks.tminus.ink",
      "oauth.tminus.ink",
    ]);
  });

  it("staging records have -staging suffix in names", () => {
    const records = buildDnsRecords("staging");
    const names = records.map((r) => r.name);
    expect(names).toEqual([
      "api-staging.tminus.ink",
      "app-staging.tminus.ink",
      "mcp-staging.tminus.ink",
      "webhooks-staging.tminus.ink",
      "oauth-staging.tminus.ink",
    ]);
  });

  it("all records are CNAME type", () => {
    for (const env of ["production", "staging"]) {
      const records = buildDnsRecords(env);
      for (const record of records) {
        expect(record.type).toBe("CNAME");
      }
    }
  });

  it("all records point to CNAME_TARGET (tminus.ink)", () => {
    for (const env of ["production", "staging"]) {
      const records = buildDnsRecords(env);
      for (const record of records) {
        expect(record.content).toBe("tminus.ink");
      }
    }
  });

  it("all records are proxied", () => {
    for (const env of ["production", "staging"]) {
      const records = buildDnsRecords(env);
      for (const record of records) {
        expect(record.proxied).toBe(true);
      }
    }
  });

  it("all records have ttl=1 (Auto)", () => {
    for (const env of ["production", "staging"]) {
      const records = buildDnsRecords(env);
      for (const record of records) {
        expect(record.ttl).toBe(1);
      }
    }
  });

  it("all records have a management comment", () => {
    for (const env of ["production", "staging"]) {
      const records = buildDnsRecords(env);
      for (const record of records) {
        expect(record.comment).toBe("Managed by T-Minus deploy pipeline");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// getRecordsForEnvironment
// ---------------------------------------------------------------------------

describe("getRecordsForEnvironment", () => {
  it("returns 5 records for production", () => {
    const records = getRecordsForEnvironment("production");
    expect(records).toHaveLength(5);
  });

  it("returns 5 records for staging", () => {
    const records = getRecordsForEnvironment("staging");
    expect(records).toHaveLength(5);
  });

  it("returns 10 records for 'all'", () => {
    const records = getRecordsForEnvironment("all");
    expect(records).toHaveLength(10);
    // First 5 are production, next 5 are staging
    expect(records[0].name).toBe("api.tminus.ink");
    expect(records[5].name).toBe("api-staging.tminus.ink");
  });

  it("throws for unknown environment", () => {
    expect(() => getRecordsForEnvironment("unknown")).toThrow(
      /Unknown environment/
    );
  });

  it("'all' contains production + staging records without overlap", () => {
    const all = getRecordsForEnvironment("all");
    const names = all.map((r) => r.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length); // no duplicates
    expect(names.length).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// getAuthHeaders
// ---------------------------------------------------------------------------

describe("getAuthHeaders", () => {
  const originalEnv = process.env.CLOUDFLARE_API_TOKEN;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLOUDFLARE_API_TOKEN;
    } else {
      process.env.CLOUDFLARE_API_TOKEN = originalEnv;
    }
  });

  it("throws when CLOUDFLARE_API_TOKEN is not set", () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    expect(() => getAuthHeaders()).toThrow(/Missing CLOUDFLARE_API_TOKEN/);
  });

  it("returns Authorization header with Bearer token", () => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token-12345";
    const headers = getAuthHeaders();
    expect(headers.Authorization).toBe("Bearer test-token-12345");
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// ensureProxiedRecord (with mocked fetch)
// ---------------------------------------------------------------------------

describe("ensureProxiedRecord", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  function mockFetch(responses) {
    let callIndex = 0;
    return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const response = responses[callIndex++];
      return {
        ok: response.ok ?? true,
        status: response.status ?? 200,
        json: async () => response.body,
      };
    });
  }

  it("creates CNAME record when none exists", async () => {
    const fetchSpy = mockFetch([
      // GET CNAME check: no existing record
      { body: { success: true, result: [] } },
      // GET A record check: no legacy record
      { body: { success: true, result: [] } },
      // POST create: success
      { body: { success: true, result: { id: "new-id" } } },
    ]);

    const result = await ensureProxiedRecord({
      zoneId: "zone-123",
      hostname: "api.tminus.ink",
    });

    expect(result).toEqual({ hostname: "api.tminus.ink", action: "created" });

    // Verify the POST body contains CNAME record
    const postCall = fetchSpy.mock.calls[2];
    expect(postCall[0]).toContain("/zones/zone-123/dns_records");
    const postBody = JSON.parse(postCall[1].body);
    expect(postBody.type).toBe("CNAME");
    expect(postBody.name).toBe("api.tminus.ink");
    expect(postBody.content).toBe("tminus.ink");
    expect(postBody.proxied).toBe(true);
    expect(postBody.ttl).toBe(1);
  });

  it("returns noop when matching CNAME already exists", async () => {
    mockFetch([
      // GET CNAME check: record exists and matches
      {
        body: {
          success: true,
          result: [
            {
              id: "existing-id",
              type: "CNAME",
              name: "api.tminus.ink",
              content: "tminus.ink",
              proxied: true,
              ttl: 1,
            },
          ],
        },
      },
    ]);

    const result = await ensureProxiedRecord({
      zoneId: "zone-123",
      hostname: "api.tminus.ink",
    });

    expect(result).toEqual({ hostname: "api.tminus.ink", action: "noop" });
  });

  it("updates CNAME when content differs", async () => {
    const fetchSpy = mockFetch([
      // GET CNAME check: record exists but wrong content
      {
        body: {
          success: true,
          result: [
            {
              id: "existing-id",
              type: "CNAME",
              name: "api.tminus.ink",
              content: "old-target.example.com",
              proxied: true,
              ttl: 1,
            },
          ],
        },
      },
      // PUT update: success
      { body: { success: true, result: { id: "existing-id" } } },
    ]);

    const result = await ensureProxiedRecord({
      zoneId: "zone-123",
      hostname: "api.tminus.ink",
    });

    expect(result).toEqual({ hostname: "api.tminus.ink", action: "updated" });

    // Verify the PUT was called with correct data
    const putCall = fetchSpy.mock.calls[1];
    expect(putCall[0]).toContain("/zones/zone-123/dns_records/existing-id");
    expect(putCall[1].method).toBe("PUT");
    const putBody = JSON.parse(putCall[1].body);
    expect(putBody.content).toBe("tminus.ink");
  });

  it("updates CNAME when proxied differs", async () => {
    mockFetch([
      // GET CNAME check: record exists but not proxied
      {
        body: {
          success: true,
          result: [
            {
              id: "existing-id",
              type: "CNAME",
              name: "api.tminus.ink",
              content: "tminus.ink",
              proxied: false,
              ttl: 1,
            },
          ],
        },
      },
      // PUT update: success
      { body: { success: true, result: { id: "existing-id" } } },
    ]);

    const result = await ensureProxiedRecord({
      zoneId: "zone-123",
      hostname: "api.tminus.ink",
    });

    expect(result).toEqual({ hostname: "api.tminus.ink", action: "updated" });
  });

  it("migrates legacy A record to CNAME", async () => {
    const fetchSpy = mockFetch([
      // GET CNAME check: no CNAME exists
      { body: { success: true, result: [] } },
      // GET A record check: legacy A record found
      {
        body: {
          success: true,
          result: [
            {
              id: "legacy-a-id",
              type: "A",
              name: "api.tminus.ink",
              content: "192.0.2.1",
              proxied: true,
              ttl: 1,
            },
          ],
        },
      },
      // DELETE the legacy A record
      { body: { success: true, result: null } },
      // POST create new CNAME
      { body: { success: true, result: { id: "new-cname-id" } } },
    ]);

    const result = await ensureProxiedRecord({
      zoneId: "zone-123",
      hostname: "api.tminus.ink",
    });

    expect(result).toEqual({ hostname: "api.tminus.ink", action: "migrated" });

    // Verify DELETE was called on the legacy A record
    const deleteCall = fetchSpy.mock.calls[2];
    expect(deleteCall[0]).toContain("/zones/zone-123/dns_records/legacy-a-id");
    expect(deleteCall[1].method).toBe("DELETE");

    // Verify POST created a CNAME
    const postCall = fetchSpy.mock.calls[3];
    const postBody = JSON.parse(postCall[1].body);
    expect(postBody.type).toBe("CNAME");
    expect(postBody.content).toBe("tminus.ink");
  });

  it("uses custom content when provided", async () => {
    const fetchSpy = mockFetch([
      // GET CNAME check: no existing
      { body: { success: true, result: [] } },
      // GET A record check: no legacy
      { body: { success: true, result: [] } },
      // POST create
      { body: { success: true, result: { id: "new-id" } } },
    ]);

    await ensureProxiedRecord({
      zoneId: "zone-123",
      hostname: "api.tminus.ink",
      content: "custom-target.example.com",
    });

    const postBody = JSON.parse(fetchSpy.mock.calls[2][1].body);
    expect(postBody.content).toBe("custom-target.example.com");
  });
});

// ---------------------------------------------------------------------------
// ensureDnsRecords (with mocked fetch)
// ---------------------------------------------------------------------------

describe("ensureDnsRecords", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  function mockFetchAllNoop() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: [
          {
            id: "existing-id",
            type: "CNAME",
            name: "match",
            content: "tminus.ink",
            proxied: true,
            ttl: 1,
          },
        ],
      }),
    }));
  }

  it("processes all 5 production hostnames", async () => {
    mockFetchAllNoop();

    const results = await ensureDnsRecords({
      zoneId: "zone-123",
      environment: "production",
    });

    expect(results).toHaveLength(5);
    const hostnames = results.map((r) => r.hostname);
    expect(hostnames).toContain("api.tminus.ink");
    expect(hostnames).toContain("app.tminus.ink");
    expect(hostnames).toContain("mcp.tminus.ink");
    expect(hostnames).toContain("webhooks.tminus.ink");
    expect(hostnames).toContain("oauth.tminus.ink");
  });

  it("processes all 5 staging hostnames", async () => {
    mockFetchAllNoop();

    const results = await ensureDnsRecords({
      zoneId: "zone-123",
      environment: "staging",
    });

    expect(results).toHaveLength(5);
    const hostnames = results.map((r) => r.hostname);
    expect(hostnames).toContain("api-staging.tminus.ink");
    expect(hostnames).toContain("app-staging.tminus.ink");
    expect(hostnames).toContain("mcp-staging.tminus.ink");
    expect(hostnames).toContain("webhooks-staging.tminus.ink");
    expect(hostnames).toContain("oauth-staging.tminus.ink");
  });

  it("throws for unknown environment", async () => {
    await expect(
      ensureDnsRecords({ zoneId: "zone-123", environment: "unknown" })
    ).rejects.toThrow(/Unknown environment/);
  });

  it("returns noop for all records when all exist", async () => {
    mockFetchAllNoop();

    const results = await ensureDnsRecords({
      zoneId: "zone-123",
      environment: "production",
    });

    for (const result of results) {
      expect(result.action).toBe("noop");
    }
  });
});

// ---------------------------------------------------------------------------
// ensureAllDnsRecords (with mocked fetch)
// ---------------------------------------------------------------------------

describe("ensureAllDnsRecords", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it("processes all 10 hostnames (production + staging)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: [
          {
            id: "existing-id",
            type: "CNAME",
            content: "tminus.ink",
            proxied: true,
            ttl: 1,
          },
        ],
      }),
    }));

    const results = await ensureAllDnsRecords({ zoneId: "zone-123" });

    expect(results).toHaveLength(10);
    const hostnames = results.map((r) => r.hostname);
    // Production
    expect(hostnames).toContain("api.tminus.ink");
    expect(hostnames).toContain("app.tminus.ink");
    expect(hostnames).toContain("mcp.tminus.ink");
    expect(hostnames).toContain("webhooks.tminus.ink");
    expect(hostnames).toContain("oauth.tminus.ink");
    // Staging
    expect(hostnames).toContain("api-staging.tminus.ink");
    expect(hostnames).toContain("app-staging.tminus.ink");
    expect(hostnames).toContain("mcp-staging.tminus.ink");
    expect(hostnames).toContain("webhooks-staging.tminus.ink");
    expect(hostnames).toContain("oauth-staging.tminus.ink");
  });
});

// ---------------------------------------------------------------------------
// cfRequest (with mocked fetch)
// ---------------------------------------------------------------------------

describe("cfRequest", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it("throws on non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        success: false,
        errors: [{ code: 9109, message: "Invalid access token" }],
      }),
    }));

    await expect(cfRequest("/zones/test")).rejects.toThrow(
      /Cloudflare API error \(403\)/
    );
  });

  it("throws on success:false response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: false,
        errors: [{ code: 1000, message: "Bad request" }],
      }),
    }));

    await expect(cfRequest("/zones/test")).rejects.toThrow(
      /Cloudflare API error/
    );
  });

  it("returns parsed data on success", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: { id: "test-id" },
      }),
    }));

    const data = await cfRequest("/zones/test");
    expect(data.success).toBe(true);
    expect(data.result.id).toBe("test-id");
  });

  it("constructs correct URL from CLOUDFLARE_API_BASE", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: {} }),
      }));

    await cfRequest("/zones/abc/dns_records");

    expect(fetchSpy.mock.calls[0][0]).toBe(
      `${CLOUDFLARE_API_BASE}/zones/abc/dns_records`
    );
  });
});

// ---------------------------------------------------------------------------
// Dry-run integration: verify record specs match what API would receive
// ---------------------------------------------------------------------------

describe("dry-run record verification", () => {
  it("all 10 records have the exact shape the CF API expects", () => {
    const allRecords = getRecordsForEnvironment("all");

    for (const record of allRecords) {
      // Required fields for Cloudflare DNS API
      expect(record).toHaveProperty("name");
      expect(record).toHaveProperty("type");
      expect(record).toHaveProperty("content");
      expect(record).toHaveProperty("proxied");
      expect(record).toHaveProperty("ttl");
      expect(record).toHaveProperty("comment");

      // Correct types
      expect(typeof record.name).toBe("string");
      expect(record.type).toBe("CNAME");
      expect(typeof record.content).toBe("string");
      expect(record.proxied).toBe(true);
      expect(record.ttl).toBe(1);
      expect(typeof record.comment).toBe("string");

      // Name format: subdomain.tminus.ink
      expect(record.name).toMatch(/^[\w-]+\.tminus\.ink$/);

      // Content must be a valid domain
      expect(record.content).toBe("tminus.ink");
    }
  });

  it("production records do not contain staging names", () => {
    const prodRecords = getRecordsForEnvironment("production");
    for (const record of prodRecords) {
      expect(record.name).not.toContain("-staging");
    }
  });

  it("staging records all contain -staging", () => {
    const stagingRecords = getRecordsForEnvironment("staging");
    for (const record of stagingRecords) {
      expect(record.name).toContain("-staging");
    }
  });
});
