/**
 * Unit tests for Google Workspace Marketplace admin install callback.
 *
 * Covers:
 * - Admin install callback parameter parsing (unit, no mocks)
 * - Admin install handler (all paths, with mocked Google APIs)
 * - Org user activation handler (all paths)
 * - Org membership detection from hosted domain (unit)
 *
 * Business rules tested:
 * - BR-1: Org install does NOT auto-sync (no OnboardingWorkflow in admin install)
 * - BR-3: Individual user activation creates per-user records
 */

import { describe, it, expect, vi } from "vitest";
import {
  parseAdminInstallCallback,
  handleAdminInstall,
  handleOrgUserActivation,
  detectOrgMembership,
} from "./marketplace-admin";
import { GOOGLE_SCOPES } from "./google";
import type { FetchFn } from "./index";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
const TEST_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const TEST_CLIENT_SECRET = "test-client-secret";
const TEST_AUTH_CODE = "4/0AbCdEfGhIjKlMnOpQrStUvWxYz-admin";
const TEST_GOOGLE_SUB = "google-sub-admin-12345";
const TEST_ADMIN_EMAIL = "admin@acme-corp.com";
const TEST_CUSTOMER_ID = "C01xxxxxx";
const TEST_HOSTED_DOMAIN = "acme-corp.com";

const TEST_USER_SUB = "google-sub-user-67890";
const TEST_USER_EMAIL = "user@acme-corp.com";

// ---------------------------------------------------------------------------
// Admin install callback parsing tests
// ---------------------------------------------------------------------------

describe("parseAdminInstallCallback", () => {
  it("parses code and customer_id from callback URL", () => {
    const url = new URL(
      `https://oauth.tminus.dev/marketplace/admin-install?code=${TEST_AUTH_CODE}&customer_id=${TEST_CUSTOMER_ID}&hd=${TEST_HOSTED_DOMAIN}`,
    );
    const result = parseAdminInstallCallback(url);

    expect(result).not.toBeNull();
    expect(result!.code).toBe(TEST_AUTH_CODE);
    expect(result!.customer_id).toBe(TEST_CUSTOMER_ID);
    expect(result!.hd).toBe(TEST_HOSTED_DOMAIN);
  });

  it("returns null when code parameter is missing", () => {
    const url = new URL(
      `https://oauth.tminus.dev/marketplace/admin-install?customer_id=${TEST_CUSTOMER_ID}`,
    );
    const result = parseAdminInstallCallback(url);
    expect(result).toBeNull();
  });

  it("returns null when customer_id parameter is missing", () => {
    const url = new URL(
      `https://oauth.tminus.dev/marketplace/admin-install?code=${TEST_AUTH_CODE}`,
    );
    const result = parseAdminInstallCallback(url);
    expect(result).toBeNull();
  });

  it("handles callback with optional scope parameter", () => {
    const url = new URL(
      `https://oauth.tminus.dev/marketplace/admin-install?code=${TEST_AUTH_CODE}&customer_id=${TEST_CUSTOMER_ID}&scope=openid+email`,
    );
    const result = parseAdminInstallCallback(url);

    expect(result).not.toBeNull();
    expect(result!.scope).toBe("openid email");
  });

  it("handles callback without optional parameters", () => {
    const url = new URL(
      `https://oauth.tminus.dev/marketplace/admin-install?code=${TEST_AUTH_CODE}&customer_id=${TEST_CUSTOMER_ID}`,
    );
    const result = parseAdminInstallCallback(url);

    expect(result).not.toBeNull();
    expect(result!.scope).toBeUndefined();
    expect(result!.hd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Org membership detection tests
// ---------------------------------------------------------------------------

describe("detectOrgMembership", () => {
  it("returns null when hosted domain is undefined", async () => {
    const mockDb = createMockD1ForOrgDetection([]);
    const result = await detectOrgMembership(undefined, mockDb);
    expect(result).toBeNull();
  });

  it("returns null when no matching org installation exists", async () => {
    const mockDb = createMockD1ForOrgDetection([]);
    const result = await detectOrgMembership("unknown.com", mockDb);
    expect(result).toBeNull();
  });

  it("returns org installation when domain matches admin email", async () => {
    const mockDb = createMockD1ForOrgDetection([
      { install_id: "oin_TEST1", org_id: "org_TEST1", google_customer_id: "C01xxx" },
    ]);
    const result = await detectOrgMembership("acme-corp.com", mockDb);

    expect(result).not.toBeNull();
    expect(result!.install_id).toBe("oin_TEST1");
    expect(result!.google_customer_id).toBe("C01xxx");
  });
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Create a mock fetch for admin install flow. */
function createAdminMockFetch(overrides?: {
  tokenResponse?: Partial<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  }>;
  tokenStatus?: number;
  userInfoResponse?: Partial<{
    sub: string;
    email: string;
    name: string;
    hd: string;
  }>;
  userInfoStatus?: number;
}): FetchFn {
  return async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("oauth2.googleapis.com/token")) {
      const status = overrides?.tokenStatus ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status });
      }
      return new Response(
        JSON.stringify({
          access_token: "ya29.admin-mock-access-token",
          refresh_token: "1//admin-mock-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: GOOGLE_SCOPES,
          ...overrides?.tokenResponse,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes("googleapis.com/oauth2/v3/userinfo")) {
      const status = overrides?.userInfoStatus ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status });
      }
      return new Response(
        JSON.stringify({
          sub: TEST_GOOGLE_SUB,
          email: TEST_ADMIN_EMAIL,
          name: "Admin User",
          hd: TEST_HOSTED_DOMAIN,
          ...overrides?.userInfoResponse,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };
}

/** Create a mock D1 for org detection tests. */
function createMockD1ForOrgDetection(
  installations: Array<{ install_id: string; org_id: string | null; google_customer_id: string }>,
) {
  return {
    prepare(sql: string) {
      const statement = {
        sql,
        bindings: [] as unknown[],
        bind(...args: unknown[]) {
          statement.bindings = args;
          return statement;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes("org_installations") && sql.includes("status = 'active'")) {
            // Return first matching installation
            if (installations.length > 0) {
              return installations[0] as T;
            }
            return null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[]; success: boolean }> {
          return { results: [], success: true };
        },
        async run(): Promise<{ success: boolean }> {
          return { success: true };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

/** Create a mock D1 for admin install handler. */
function createAdminMockD1() {
  const installations: Array<Record<string, unknown>> = [];
  const orgs: Array<Record<string, unknown>> = [];
  const users: Array<Record<string, unknown>> = [];
  const accounts: Array<Record<string, unknown>> = [];

  return {
    _installations: installations,
    _orgs: orgs,
    _users: users,
    _accounts: accounts,

    prepare(sql: string) {
      const statement = {
        sql,
        bindings: [] as unknown[],
        bind(...args: unknown[]) {
          statement.bindings = args;
          return statement;
        },
        async first<T>(): Promise<T | null> {
          // Org membership detection: admin_email LIKE pattern
          if (sql.includes("org_installations") && sql.includes("admin_email LIKE")) {
            const found = installations.find((i) => i.status === "active");
            return (found as T) ?? null;
          }
          // Check existing org installation by google_customer_id
          if (sql.includes("org_installations") && sql.includes("google_customer_id") && sql.includes("WHERE")) {
            const customerId = statement.bindings[0] as string;
            const found = installations.find((i) => i.google_customer_id === customerId);
            return (found as T) ?? null;
          }
          // Check existing organization
          if (sql.includes("organizations") && sql.includes("name")) {
            return null; // No existing org by default
          }
          // Org installation lookup by org_id
          if (sql.includes("org_installations") && sql.includes("org_id") && !sql.includes("google_customer_id")) {
            const orgId = statement.bindings[0] as string;
            const found = installations.find((i) => i.org_id === orgId);
            return (found as T) ?? null;
          }
          // Org installations with status check (fallback)
          if (sql.includes("org_installations") && sql.includes("status = 'active'")) {
            const found = installations.find((i) => i.status === "active");
            return (found as T) ?? null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[]; success: boolean }> {
          if (sql.includes("SELECT") && sql.includes("users") && sql.includes("email")) {
            const email = statement.bindings[0] as string;
            const found = users.filter((u) => u.email === email) as T[];
            return { results: found, success: true };
          }
          if (sql.includes("SELECT") && sql.includes("accounts") && sql.includes("provider_subject")) {
            const providerSubject = statement.bindings[1] as string;
            const found = accounts.filter((a) => a.provider_subject === providerSubject) as T[];
            return { results: found, success: true };
          }
          return { results: [], success: true };
        },
        async run(): Promise<{ success: boolean }> {
          if (sql.includes("INSERT") && sql.includes("org_installations")) {
            installations.push({
              install_id: statement.bindings[0],
              google_customer_id: statement.bindings[1],
              org_id: statement.bindings[2],
              admin_email: statement.bindings[3],
              admin_google_sub: statement.bindings[4],
              scopes_granted: statement.bindings[5],
              status: "active",
            });
          }
          if (sql.includes("UPDATE") && sql.includes("org_installations")) {
            // Update existing installation
            for (const inst of installations) {
              if (inst.install_id === statement.bindings[statement.bindings.length - 1]) {
                inst.status = "active";
                inst.admin_email = statement.bindings[0];
              }
            }
          }
          if (sql.includes("INSERT") && sql.includes("orgs") && !sql.includes("org_installations")) {
            orgs.push({
              org_id: statement.bindings[0],
              name: statement.bindings[1],
            });
          }
          if (sql.includes("INSERT") && sql.includes("users") && !sql.includes("orgs")) {
            users.push({
              user_id: statement.bindings[0],
              org_id: statement.bindings[1],
              email: statement.bindings[2],
              display_name: statement.bindings[3],
            });
          }
          if (sql.includes("INSERT") && sql.includes("accounts")) {
            accounts.push({
              account_id: statement.bindings[0],
              user_id: statement.bindings[1],
              provider: "google",
              provider_subject: statement.bindings[2],
              email: statement.bindings[3],
              status: "active",
            });
          }
          return { success: true };
        },
      };
      return statement;
    },
  };
}

/** Create a minimal mock AccountDO namespace. */
function createMockAccountDO() {
  const calls: Array<{ id: string; url: string; body: unknown }> = [];

  return {
    _calls: calls,
    idFromName(name: string) {
      return { name };
    },
    get(id: { name: string }) {
      return {
        async fetch(request: Request) {
          const body = await request.json();
          calls.push({ id: id.name, url: request.url, body });
          return new Response("OK", { status: 200 });
        },
      };
    },
  };
}

/** Create a minimal mock Workflow binding. */
function createMockWorkflow() {
  const calls: Array<{ id: string; params: Record<string, unknown> }> = [];

  return {
    _calls: calls,
    async create(options: { id?: string; params: Record<string, unknown> }) {
      calls.push({ id: options.id || "auto", params: options.params });
      return { id: options.id || "auto" };
    },
  };
}

/** Build mock Env for admin install tests. */
function createAdminMockEnv(overrides?: {
  d1?: ReturnType<typeof createAdminMockD1>;
  accountDO?: ReturnType<typeof createMockAccountDO>;
  workflow?: ReturnType<typeof createMockWorkflow>;
}) {
  return {
    DB: overrides?.d1 ?? createAdminMockD1(),
    USER_GRAPH: {} as DurableObjectNamespace,
    ACCOUNT: overrides?.accountDO ?? createMockAccountDO(),
    ONBOARDING_WORKFLOW: overrides?.workflow ?? createMockWorkflow(),
    GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: TEST_CLIENT_SECRET,
    MS_CLIENT_ID: "unused",
    MS_CLIENT_SECRET: "unused",
    JWT_SECRET: TEST_JWT_SECRET,
  } as unknown as Env;
}

// ---------------------------------------------------------------------------
// Admin install handler tests
// ---------------------------------------------------------------------------

describe("handleAdminInstall", () => {
  describe("new org install (happy path)", () => {
    it("creates org installation record and redirects to confirmation", async () => {
      const d1 = createAdminMockD1();
      const env = createAdminMockEnv({ d1 });
      const mockFetch = createAdminMockFetch();

      const request = new Request(
        `https://oauth.tminus.dev/marketplace/admin-install?code=${TEST_AUTH_CODE}&customer_id=${TEST_CUSTOMER_ID}&hd=${TEST_HOSTED_DOMAIN}`,
      );
      const response = await handleAdminInstall(request, env, mockFetch);

      // Should redirect
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location")!);
      expect(location.pathname).toBe("/onboarding");

      // Admin install flag is set
      expect(location.searchParams.get("admin_install")).toBe("true");
      expect(location.searchParams.get("customer_id")).toBe(TEST_CUSTOMER_ID);
      expect(location.searchParams.get("admin_email")).toBe(TEST_ADMIN_EMAIL);

      // Installation record was created
      expect(d1._installations.length).toBe(1);
      expect(d1._installations[0].google_customer_id).toBe(TEST_CUSTOMER_ID);
      expect(d1._installations[0].admin_email).toBe(TEST_ADMIN_EMAIL);
      expect(d1._installations[0].admin_google_sub).toBe(TEST_GOOGLE_SUB);
      expect(d1._installations[0].status).toBe("active");

      // BR-1: No OnboardingWorkflow started (org install does NOT auto-sync)
      const workflow = (env as any).ONBOARDING_WORKFLOW;
      expect(workflow._calls.length).toBe(0);

      // BR-1: No AccountDO initialized (no per-user tokens in admin install)
      const accountDO = (env as any).ACCOUNT;
      expect(accountDO._calls.length).toBe(0);
    });
  });

  describe("error handling", () => {
    it("returns user-friendly error when Google sends error parameter", async () => {
      const env = createAdminMockEnv();
      const request = new Request(
        "https://oauth.tminus.dev/marketplace/admin-install?error=access_denied",
      );
      const response = await handleAdminInstall(request, env);

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("cancelled or denied");
    });

    it("returns 400 when customer_id is missing", async () => {
      const env = createAdminMockEnv();
      const request = new Request(
        `https://oauth.tminus.dev/marketplace/admin-install?code=${TEST_AUTH_CODE}`,
      );
      const response = await handleAdminInstall(request, env);

      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain("customer_id");
    });

    it("returns 400 when code is missing", async () => {
      const env = createAdminMockEnv();
      const request = new Request(
        `https://oauth.tminus.dev/marketplace/admin-install?customer_id=${TEST_CUSTOMER_ID}`,
      );
      const response = await handleAdminInstall(request, env);

      expect(response.status).toBe(400);
    });

    it("returns 502 when token exchange fails", async () => {
      const env = createAdminMockEnv();
      const mockFetch = createAdminMockFetch({ tokenStatus: 400 });

      const request = new Request(
        `https://oauth.tminus.dev/marketplace/admin-install?code=bad&customer_id=${TEST_CUSTOMER_ID}`,
      );
      const response = await handleAdminInstall(request, env, mockFetch);

      expect(response.status).toBe(502);
    });

    it("returns 502 when userinfo fetch fails", async () => {
      const env = createAdminMockEnv();
      const mockFetch = createAdminMockFetch({ userInfoStatus: 401 });

      const request = new Request(
        `https://oauth.tminus.dev/marketplace/admin-install?code=${TEST_AUTH_CODE}&customer_id=${TEST_CUSTOMER_ID}`,
      );
      const response = await handleAdminInstall(request, env, mockFetch);

      expect(response.status).toBe(502);
    });
  });
});

// ---------------------------------------------------------------------------
// Org user activation handler tests
// ---------------------------------------------------------------------------

describe("handleOrgUserActivation", () => {
  describe("new org user (happy path)", () => {
    it("creates user and account, skips OAuth consent, redirects to onboarding", async () => {
      const d1 = createAdminMockD1();
      // Pre-populate an active org installation
      d1._installations.push({
        install_id: "oin_TEST_01",
        google_customer_id: TEST_CUSTOMER_ID,
        org_id: null,
        admin_email: TEST_ADMIN_EMAIL,
        admin_google_sub: TEST_GOOGLE_SUB,
        scopes_granted: GOOGLE_SCOPES,
        status: "active",
      });

      const accountDO = createMockAccountDO();
      const workflow = createMockWorkflow();
      const env = createAdminMockEnv({ d1, accountDO, workflow });

      const mockFetch = createAdminMockFetch({
        userInfoResponse: {
          sub: TEST_USER_SUB,
          email: TEST_USER_EMAIL,
          name: "Org User",
          hd: TEST_HOSTED_DOMAIN,
        },
      });

      const request = new Request(
        `https://oauth.tminus.dev/marketplace/org-activate?code=${TEST_AUTH_CODE}`,
      );
      const response = await handleOrgUserActivation(request, env, mockFetch);

      // Should redirect to onboarding
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location")!);
      expect(location.pathname).toBe("/onboarding");

      // Org install flag set
      expect(location.searchParams.get("org_install")).toBe("true");
      expect(location.searchParams.get("marketplace_install")).toBe("true");
      expect(location.searchParams.get("provider")).toBe("google");
      expect(location.searchParams.get("email")).toBe(TEST_USER_EMAIL);

      // User was created
      expect(d1._users.length).toBe(1);
      expect(d1._users[0].email).toBe(TEST_USER_EMAIL);

      // Account was created
      expect(d1._accounts.length).toBe(1);
      expect(d1._accounts[0].provider_subject).toBe(TEST_USER_SUB);

      // AccountDO was initialized
      expect(accountDO._calls.length).toBe(1);

      // OnboardingWorkflow was started
      expect(workflow._calls.length).toBe(1);
    });
  });

  describe("error handling", () => {
    it("returns 403 when org has no active installation", async () => {
      const d1 = createAdminMockD1();
      // No installations
      const env = createAdminMockEnv({ d1 });
      const mockFetch = createAdminMockFetch({
        userInfoResponse: {
          sub: TEST_USER_SUB,
          email: TEST_USER_EMAIL,
          hd: "unknown-org.com",
        },
      });

      const request = new Request(
        `https://oauth.tminus.dev/marketplace/org-activate?code=${TEST_AUTH_CODE}`,
      );
      const response = await handleOrgUserActivation(request, env, mockFetch);

      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).toContain("does not have T-Minus installed");
    });

    it("returns 400 when code is missing", async () => {
      const env = createAdminMockEnv();
      const request = new Request(
        "https://oauth.tminus.dev/marketplace/org-activate",
      );
      const response = await handleOrgUserActivation(request, env);

      expect(response.status).toBe(400);
    });

    it("returns user-friendly error when Google sends error parameter", async () => {
      const env = createAdminMockEnv();
      const request = new Request(
        "https://oauth.tminus.dev/marketplace/org-activate?error=access_denied",
      );
      const response = await handleOrgUserActivation(request, env);

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("cancelled or denied");
    });

    it("returns 502 when token exchange fails", async () => {
      const env = createAdminMockEnv();
      const mockFetch = createAdminMockFetch({ tokenStatus: 400 });

      const request = new Request(
        `https://oauth.tminus.dev/marketplace/org-activate?code=bad`,
      );
      const response = await handleOrgUserActivation(request, env, mockFetch);

      expect(response.status).toBe(502);
    });

    it("returns 502 when no refresh_token", async () => {
      const env = createAdminMockEnv();
      const mockFetch = createAdminMockFetch({
        tokenResponse: { refresh_token: undefined } as any,
      });

      const request = new Request(
        `https://oauth.tminus.dev/marketplace/org-activate?code=${TEST_AUTH_CODE}`,
      );
      const response = await handleOrgUserActivation(request, env, mockFetch);

      expect(response.status).toBe(502);
    });
  });
});
