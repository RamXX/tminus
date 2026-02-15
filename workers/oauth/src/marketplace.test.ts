/**
 * Unit tests for Google Workspace Marketplace install callback.
 *
 * Covers:
 * - Marketplace callback parameter parsing (unit, no mocks)
 * - Marketplace manifest configuration (unit, no mocks)
 * - Marketplace install handler (all paths, with mocked Google APIs)
 *
 * Google API calls are mocked via injectable fetch. D1 and DO are mocked
 * with lightweight stubs that verify correct interactions (same pattern as
 * oauth.test.ts).
 */

import { describe, it, expect, vi } from "vitest";
import {
  parseMarketplaceCallback,
  handleMarketplaceInstall,
} from "./marketplace";
import { createMarketplaceManifest } from "./marketplace-manifest";
import { GOOGLE_SCOPES } from "./google";
import type { FetchFn } from "./index";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
const TEST_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const TEST_CLIENT_SECRET = "test-client-secret";
const TEST_AUTH_CODE = "4/0AbCdEfGhIjKlMnOpQrStUvWxYz-marketplace";
const TEST_GOOGLE_SUB = "google-sub-marketplace-12345";
const TEST_GOOGLE_EMAIL = "user@workspace.example.com";
const TEST_HOSTED_DOMAIN = "workspace.example.com";

// ---------------------------------------------------------------------------
// Marketplace callback parsing tests
// ---------------------------------------------------------------------------

describe("parseMarketplaceCallback", () => {
  it("parses code, scope, and hd from callback URL", () => {
    const url = new URL(
      `https://oauth.tminus.dev/marketplace/install?code=${TEST_AUTH_CODE}&scope=openid+email&hd=${TEST_HOSTED_DOMAIN}`,
    );
    const result = parseMarketplaceCallback(url);

    expect(result).not.toBeNull();
    expect(result!.code).toBe(TEST_AUTH_CODE);
    expect(result!.scope).toBe("openid email");
    expect(result!.hd).toBe(TEST_HOSTED_DOMAIN);
  });

  it("returns null when code parameter is missing", () => {
    const url = new URL("https://oauth.tminus.dev/marketplace/install?scope=openid");
    const result = parseMarketplaceCallback(url);
    expect(result).toBeNull();
  });

  it("handles callback with only code (no scope, no hd)", () => {
    const url = new URL(`https://oauth.tminus.dev/marketplace/install?code=${TEST_AUTH_CODE}`);
    const result = parseMarketplaceCallback(url);

    expect(result).not.toBeNull();
    expect(result!.code).toBe(TEST_AUTH_CODE);
    expect(result!.scope).toBeUndefined();
    expect(result!.hd).toBeUndefined();
  });

  it("preserves URL-encoded characters in code parameter", () => {
    const encodedCode = "4%2F0AbCdEf%2BGhIj";
    const url = new URL(`https://oauth.tminus.dev/marketplace/install?code=${encodedCode}`);
    const result = parseMarketplaceCallback(url);

    expect(result).not.toBeNull();
    // URL class auto-decodes search params
    expect(result!.code).toBe("4/0AbCdEf+GhIj");
  });
});

// ---------------------------------------------------------------------------
// Marketplace manifest tests
// ---------------------------------------------------------------------------

describe("createMarketplaceManifest", () => {
  it("creates manifest with correct app name and URLs", () => {
    const manifest = createMarketplaceManifest(
      "https://oauth.tminus.ink",
      TEST_CLIENT_ID,
    );

    expect(manifest.app_name).toBe("T-Minus");
    expect(manifest.install_url).toBe("https://oauth.tminus.ink/marketplace/install");
    expect(manifest.uninstall_url).toBe("https://oauth.tminus.ink/marketplace/uninstall");
    expect(manifest.privacy_policy_url).toBe("https://oauth.tminus.ink/legal/privacy");
    expect(manifest.terms_of_service_url).toBe("https://oauth.tminus.ink/legal/terms");
    expect(manifest.support_url).toBe("https://oauth.tminus.ink/support");
  });

  it("includes required calendar and identity scopes", () => {
    const manifest = createMarketplaceManifest("https://oauth.tminus.ink", TEST_CLIENT_ID);

    expect(manifest.scopes).toContain("https://www.googleapis.com/auth/calendar");
    expect(manifest.scopes).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(manifest.scopes).toContain("openid");
    expect(manifest.scopes).toContain("email");
    expect(manifest.scopes).toContain("profile");
  });

  it("sets correct OAuth client ID", () => {
    const manifest = createMarketplaceManifest("https://oauth.tminus.ink", TEST_CLIENT_ID);
    expect(manifest.oauth_client_id).toBe(TEST_CLIENT_ID);
  });

  it("short description is under 80 characters", () => {
    const manifest = createMarketplaceManifest("https://oauth.tminus.ink", TEST_CLIENT_ID);
    expect(manifest.short_description.length).toBeLessThanOrEqual(80);
  });

  it("enables both individual install and admin install (Phase 6B org-level)", () => {
    const manifest = createMarketplaceManifest("https://oauth.tminus.ink", TEST_CLIENT_ID);
    expect(manifest.individual_install).toBe(true);
    expect(manifest.admin_install).toBe(true);
  });

  it("category is Productivity", () => {
    const manifest = createMarketplaceManifest("https://oauth.tminus.ink", TEST_CLIENT_ID);
    expect(manifest.category).toBe("Productivity");
  });
});

// ---------------------------------------------------------------------------
// Mock helpers (following oauth.test.ts pattern)
// ---------------------------------------------------------------------------

/** Create a mock fetch for Google token and userinfo endpoints. */
function createMockGoogleFetch(overrides?: {
  tokenResponse?: Partial<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
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
          access_token: "ya29.marketplace-mock-access-token",
          refresh_token: "1//marketplace-mock-refresh-token",
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
          email: TEST_GOOGLE_EMAIL,
          name: "Marketplace User",
          hd: TEST_HOSTED_DOMAIN,
          ...overrides?.userInfoResponse,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };
}

/** Create a minimal mock D1 with user and account tracking. */
function createMockD1() {
  const users: Array<Record<string, unknown>> = [];
  const accounts: Array<Record<string, unknown>> = [];
  const orgs: Array<Record<string, unknown>> = [];

  return {
    _users: users,
    _accounts: accounts,
    _orgs: orgs,

    prepare(sql: string) {
      const statement = {
        sql,
        bindings: [] as unknown[],
        bind(...args: unknown[]) {
          statement.bindings = args;
          return statement;
        },
        async all<T>(): Promise<{ results: T[]; success: boolean }> {
          // SELECT from users by email
          if (sql.includes("SELECT") && sql.includes("users") && sql.includes("email")) {
            const email = statement.bindings[0] as string;
            const found = users.filter((u) => u.email === email) as T[];
            return { results: found, success: true };
          }
          // SELECT from accounts by provider + provider_subject
          if (sql.includes("SELECT") && sql.includes("accounts") && sql.includes("provider_subject")) {
            const providerSubject = statement.bindings[1] as string;
            const found = accounts.filter(
              (a) => a.provider_subject === providerSubject,
            ) as T[];
            return { results: found, success: true };
          }
          return { results: [], success: true };
        },
        async run(): Promise<{ success: boolean }> {
          // INSERT INTO orgs
          if (sql.includes("INSERT") && sql.includes("orgs")) {
            orgs.push({
              org_id: statement.bindings[0],
              name: statement.bindings[1],
            });
          }
          // INSERT INTO users
          if (sql.includes("INSERT") && sql.includes("users") && !sql.includes("orgs")) {
            users.push({
              user_id: statement.bindings[0],
              org_id: statement.bindings[1],
              email: statement.bindings[2],
              display_name: statement.bindings[3],
            });
          }
          // INSERT INTO accounts
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
          // UPDATE accounts
          if (sql.includes("UPDATE") && sql.includes("accounts")) {
            const targetId = statement.bindings[statement.bindings.length - 1];
            for (const acct of accounts) {
              if (acct.account_id === targetId) {
                acct.status = "active";
              }
            }
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

/** Build mock Env. */
function createMockEnv(overrides?: {
  d1?: ReturnType<typeof createMockD1>;
  accountDO?: ReturnType<typeof createMockAccountDO>;
  workflow?: ReturnType<typeof createMockWorkflow>;
}) {
  return {
    DB: overrides?.d1 ?? createMockD1(),
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
// Marketplace install handler tests -- success paths
// ---------------------------------------------------------------------------

describe("handleMarketplaceInstall", () => {
  describe("new user (happy path)", () => {
    it("exchanges code, creates user + account, initializes DO, redirects to onboarding", async () => {
      const d1 = createMockD1();
      const accountDO = createMockAccountDO();
      const workflow = createMockWorkflow();
      const env = createMockEnv({ d1, accountDO, workflow });
      const mockFetch = createMockGoogleFetch();

      const request = new Request(
        `https://oauth.tminus.dev/marketplace/install?code=${TEST_AUTH_CODE}&hd=${TEST_HOSTED_DOMAIN}`,
      );
      const response = await handleMarketplaceInstall(request, env, mockFetch);

      // Should redirect to onboarding
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location")!);
      expect(location.pathname).toBe("/onboarding");

      // Redirect contains pre-connection info
      expect(location.searchParams.get("marketplace_install")).toBe("true");
      expect(location.searchParams.get("provider")).toBe("google");
      expect(location.searchParams.get("email")).toBe(TEST_GOOGLE_EMAIL);

      // user_id and account_id present
      const userId = location.searchParams.get("user_id")!;
      const accountId = location.searchParams.get("account_id")!;
      expect(userId).toMatch(/^usr_/);
      expect(accountId).toMatch(/^acc_/);

      // D1: user was created
      expect(d1._users.length).toBe(1);
      expect(d1._users[0].email).toBe(TEST_GOOGLE_EMAIL);
      expect(d1._users[0].display_name).toBe("Marketplace User");

      // D1: org was created with hosted domain name
      expect(d1._orgs.length).toBe(1);
      expect(d1._orgs[0].name).toBe(TEST_HOSTED_DOMAIN);

      // D1: account was created
      expect(d1._accounts.length).toBe(1);
      expect(d1._accounts[0].user_id).toBe(userId);
      expect(d1._accounts[0].provider).toBe("google");
      expect(d1._accounts[0].provider_subject).toBe(TEST_GOOGLE_SUB);

      // AccountDO: initialized with tokens
      expect(accountDO._calls.length).toBe(1);
      expect(accountDO._calls[0].url).toContain("initialize");
      const doBody = accountDO._calls[0].body as Record<string, unknown>;
      const tokens = doBody.tokens as Record<string, string>;
      expect(tokens.access_token).toBe("ya29.marketplace-mock-access-token");
      expect(tokens.refresh_token).toBe("1//marketplace-mock-refresh-token");

      // OnboardingWorkflow: started
      expect(workflow._calls.length).toBe(1);
      expect(workflow._calls[0].params.account_id).toBe(accountId);
      expect(workflow._calls[0].params.user_id).toBe(userId);
    });
  });

  describe("existing user", () => {
    it("finds existing user and creates new account, sets existing_user param", async () => {
      const d1 = createMockD1();
      // Pre-populate existing user
      d1._users.push({
        user_id: "usr_EXISTING_MARKETPLACE_01",
        org_id: "org_EXISTING",
        email: TEST_GOOGLE_EMAIL,
        display_name: "Existing User",
      });

      const accountDO = createMockAccountDO();
      const workflow = createMockWorkflow();
      const env = createMockEnv({ d1, accountDO, workflow });
      const mockFetch = createMockGoogleFetch();

      const request = new Request(
        `https://oauth.tminus.dev/marketplace/install?code=${TEST_AUTH_CODE}`,
      );
      const response = await handleMarketplaceInstall(request, env, mockFetch);

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location")!);

      // Uses existing user ID
      expect(location.searchParams.get("user_id")).toBe("usr_EXISTING_MARKETPLACE_01");
      // Indicates existing user
      expect(location.searchParams.get("existing_user")).toBe("true");

      // No new user created (still just the pre-populated one)
      expect(d1._users.length).toBe(1);

      // Account was created for the existing user
      expect(d1._accounts.length).toBe(1);
      expect(d1._accounts[0].user_id).toBe("usr_EXISTING_MARKETPLACE_01");
    });
  });

  describe("existing Google account (re-install)", () => {
    it("reactivates existing account instead of creating a new one", async () => {
      const d1 = createMockD1();
      // Pre-populate existing user + account
      d1._users.push({
        user_id: "usr_REINSTALL_01",
        email: TEST_GOOGLE_EMAIL,
      });
      d1._accounts.push({
        account_id: "acc_REINSTALL_01",
        user_id: "usr_REINSTALL_01",
        provider: "google",
        provider_subject: TEST_GOOGLE_SUB,
        email: TEST_GOOGLE_EMAIL,
        status: "revoked",
      });

      const accountDO = createMockAccountDO();
      const workflow = createMockWorkflow();
      const env = createMockEnv({ d1, accountDO, workflow });
      const mockFetch = createMockGoogleFetch();

      const request = new Request(
        `https://oauth.tminus.dev/marketplace/install?code=${TEST_AUTH_CODE}`,
      );
      const response = await handleMarketplaceInstall(request, env, mockFetch);

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location")!);

      // Uses existing account ID
      expect(location.searchParams.get("account_id")).toBe("acc_REINSTALL_01");

      // Account was NOT re-created (still just 1)
      expect(d1._accounts.length).toBe(1);

      // AccountDO was still initialized (to refresh tokens)
      expect(accountDO._calls.length).toBe(1);
      expect(accountDO._calls[0].id).toBe("acc_REINSTALL_01");

      // Workflow was NOT started (existing account)
      expect(workflow._calls.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Error paths
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("returns user-friendly message when Google sends error parameter", async () => {
      const env = createMockEnv();

      const request = new Request(
        "https://oauth.tminus.dev/marketplace/install?error=access_denied",
      );
      const response = await handleMarketplaceInstall(request, env);

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("cancelled or denied");
    });

    it("returns 400 when code parameter is missing", async () => {
      const env = createMockEnv();

      const request = new Request(
        "https://oauth.tminus.dev/marketplace/install?scope=openid",
      );
      const response = await handleMarketplaceInstall(request, env);

      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain("Missing required parameters");
    });

    it("returns 502 when token exchange fails", async () => {
      const env = createMockEnv();
      const mockFetch = createMockGoogleFetch({ tokenStatus: 400 });

      const request = new Request(
        `https://oauth.tminus.dev/marketplace/install?code=bad-code`,
      );
      const response = await handleMarketplaceInstall(request, env, mockFetch);

      expect(response.status).toBe(502);
      const body = await response.text();
      expect(body).toContain("Something went wrong");
    });

    it("returns 502 when no refresh_token in response", async () => {
      const env = createMockEnv();
      const mockFetch = createMockGoogleFetch({
        tokenResponse: { refresh_token: undefined } as any,
      });

      const request = new Request(
        `https://oauth.tminus.dev/marketplace/install?code=${TEST_AUTH_CODE}`,
      );
      const response = await handleMarketplaceInstall(request, env, mockFetch);

      expect(response.status).toBe(502);
    });

    it("returns 502 when userinfo fetch fails", async () => {
      const env = createMockEnv();
      const mockFetch = createMockGoogleFetch({ userInfoStatus: 401 });

      const request = new Request(
        `https://oauth.tminus.dev/marketplace/install?code=${TEST_AUTH_CODE}`,
      );
      const response = await handleMarketplaceInstall(request, env, mockFetch);

      expect(response.status).toBe(502);
    });
  });

  describe("org naming from hosted domain", () => {
    it("uses hosted domain (hd) from Google as org name for Workspace users", async () => {
      const d1 = createMockD1();
      const env = createMockEnv({ d1 });
      const mockFetch = createMockGoogleFetch({
        userInfoResponse: { hd: "acme-corp.com" },
      });

      const request = new Request(
        `https://oauth.tminus.dev/marketplace/install?code=${TEST_AUTH_CODE}`,
      );
      await handleMarketplaceInstall(request, env, mockFetch);

      expect(d1._orgs.length).toBe(1);
      expect(d1._orgs[0].name).toBe("acme-corp.com");
    });

    it("uses 'Personal' as org name when no hosted domain", async () => {
      const d1 = createMockD1();
      const env = createMockEnv({ d1 });
      const mockFetch = createMockGoogleFetch({
        userInfoResponse: { hd: undefined } as any,
      });

      const request = new Request(
        `https://oauth.tminus.dev/marketplace/install?code=${TEST_AUTH_CODE}`,
      );
      await handleMarketplaceInstall(request, env, mockFetch);

      expect(d1._orgs.length).toBe(1);
      expect(d1._orgs[0].name).toBe("Personal");
    });
  });
});
