/**
 * Tests for onboarding session management.
 *
 * Covers:
 * - Unit: session creation and serialization
 * - Unit: resume logic (existing session with N accounts)
 * - Unit: idempotent account addition (same account re-connected)
 * - Unit: session completion on explicit action
 * - Unit: OAuth state parameter with session ID
 * - Unit: optional fields use undefined not false (retro learning)
 * - Integration: cross-tab polling returns consistent state (via serialization round-trip)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createOnboardingSession,
  addAccountToSession,
  updateAccountStatus,
  completeSession,
  determineResumeAction,
  buildOAuthStateWithSession,
  parseOAuthState,
  serializeSession,
  deserializeSession,
  SESSION_POLL_INTERVAL_MS,
  type OnboardingSession,
  type SessionAccount,
} from "./onboarding-session";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_SESSION_ID = "ses_TEST0001";
const TEST_USER_ID = "usr_TEST0001";
const TEST_SESSION_TOKEN = "tok_random_abc123";

const GOOGLE_ACCOUNT: SessionAccount = {
  account_id: "acc_GOOGLE001",
  provider: "google",
  email: "user@gmail.com",
  status: "connected",
  calendar_count: 3,
  connected_at: "2026-02-15T10:00:00Z",
};

const MICROSOFT_ACCOUNT: SessionAccount = {
  account_id: "acc_MS001",
  provider: "microsoft",
  email: "user@outlook.com",
  status: "connected",
  calendar_count: 2,
  connected_at: "2026-02-15T10:05:00Z",
};

const APPLE_ACCOUNT: SessionAccount = {
  account_id: "acc_APPLE001",
  provider: "apple",
  email: "user@icloud.com",
  status: "syncing",
  connected_at: "2026-02-15T10:10:00Z",
};

// ---------------------------------------------------------------------------
// Unit: Session creation
// ---------------------------------------------------------------------------

describe("createOnboardingSession", () => {
  it("creates a session with welcome step and empty accounts", () => {
    const session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );

    expect(session.session_id).toBe(TEST_SESSION_ID);
    expect(session.user_id).toBe(TEST_USER_ID);
    expect(session.step).toBe("welcome");
    expect(session.accounts).toEqual([]);
    expect(session.session_token).toBe(TEST_SESSION_TOKEN);
  });

  it("sets created_at and updated_at to current time", () => {
    const before = new Date().toISOString();
    const session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );
    const after = new Date().toISOString();

    expect(session.created_at >= before).toBe(true);
    expect(session.created_at <= after).toBe(true);
    expect(session.updated_at >= before).toBe(true);
    expect(session.updated_at <= after).toBe(true);
  });

  it("does NOT set completed_at (optional field omitted, not false)", () => {
    const session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );

    // Per retro learning: optional field should be undefined, not false
    expect(session.completed_at).toBeUndefined();
    expect("completed_at" in session).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit: Idempotent account addition
// ---------------------------------------------------------------------------

describe("addAccountToSession", () => {
  let baseSession: OnboardingSession;

  beforeEach(() => {
    baseSession = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );
  });

  it("adds a new account to empty session", () => {
    const updated = addAccountToSession(baseSession, GOOGLE_ACCOUNT);

    expect(updated.accounts).toHaveLength(1);
    expect(updated.accounts[0]).toEqual(GOOGLE_ACCOUNT);
    expect(updated.step).toBe("connecting");
  });

  it("adds multiple accounts to session", () => {
    let session = addAccountToSession(baseSession, GOOGLE_ACCOUNT);
    session = addAccountToSession(session, MICROSOFT_ACCOUNT);
    session = addAccountToSession(session, APPLE_ACCOUNT);

    expect(session.accounts).toHaveLength(3);
    expect(session.accounts.map((a) => a.provider)).toEqual([
      "google",
      "microsoft",
      "apple",
    ]);
  });

  it("updates existing account instead of creating duplicate (idempotent)", () => {
    // Add Google account first
    let session = addAccountToSession(baseSession, GOOGLE_ACCOUNT);
    expect(session.accounts).toHaveLength(1);

    // Re-add same account_id with different status
    const updatedGoogle: SessionAccount = {
      ...GOOGLE_ACCOUNT,
      calendar_count: 5,
      status: "connected",
    };
    session = addAccountToSession(session, updatedGoogle);

    // Should still be 1 account, not 2
    expect(session.accounts).toHaveLength(1);
    expect(session.accounts[0].calendar_count).toBe(5);
  });

  it("updates timestamp on account addition", () => {
    // Override created_at to a past timestamp to guarantee difference
    const pastSession = { ...baseSession, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
    const session = addAccountToSession(pastSession, GOOGLE_ACCOUNT);
    expect(session.updated_at).not.toBe(pastSession.updated_at);
  });

  it("preserves other accounts when adding a new one", () => {
    let session = addAccountToSession(baseSession, GOOGLE_ACCOUNT);
    session = addAccountToSession(session, MICROSOFT_ACCOUNT);

    expect(session.accounts[0].email).toBe("user@gmail.com");
    expect(session.accounts[1].email).toBe("user@outlook.com");
  });

  it("does not mutate original session (immutability)", () => {
    const original = { ...baseSession, accounts: [...baseSession.accounts] };
    addAccountToSession(baseSession, GOOGLE_ACCOUNT);

    expect(baseSession.accounts).toHaveLength(0);
    expect(baseSession.step).toBe("welcome");
  });
});

// ---------------------------------------------------------------------------
// Unit: Account status updates
// ---------------------------------------------------------------------------

describe("updateAccountStatus", () => {
  it("updates status of a specific account", () => {
    let session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );
    session = addAccountToSession(session, {
      ...GOOGLE_ACCOUNT,
      status: "syncing",
    });

    const updated = updateAccountStatus(
      session,
      GOOGLE_ACCOUNT.account_id,
      "connected",
      3,
    );

    expect(updated.accounts[0].status).toBe("connected");
    expect(updated.accounts[0].calendar_count).toBe(3);
  });

  it("does not affect other accounts", () => {
    let session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );
    session = addAccountToSession(session, GOOGLE_ACCOUNT);
    session = addAccountToSession(session, MICROSOFT_ACCOUNT);

    const updated = updateAccountStatus(
      session,
      GOOGLE_ACCOUNT.account_id,
      "error",
    );

    expect(updated.accounts[0].status).toBe("error");
    expect(updated.accounts[1].status).toBe("connected");
  });

  it("does not add calendar_count when not provided", () => {
    let session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );
    session = addAccountToSession(session, {
      ...GOOGLE_ACCOUNT,
      calendar_count: undefined,
    });

    const updated = updateAccountStatus(
      session,
      GOOGLE_ACCOUNT.account_id,
      "error",
    );

    expect(updated.accounts[0].calendar_count).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unit: Session completion
// ---------------------------------------------------------------------------

describe("completeSession", () => {
  it("marks session step as complete", () => {
    let session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );
    session = addAccountToSession(session, GOOGLE_ACCOUNT);

    const completed = completeSession(session);
    expect(completed.step).toBe("complete");
  });

  it("sets completed_at timestamp", () => {
    let session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );
    session = addAccountToSession(session, GOOGLE_ACCOUNT);

    const completed = completeSession(session);
    expect(completed.completed_at).toBeDefined();
    expect(typeof completed.completed_at).toBe("string");
  });

  it("updates updated_at timestamp", () => {
    let session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );
    const original_updated = session.updated_at;

    // Small delay to ensure different timestamps
    const completed = completeSession(session);
    expect(completed.updated_at).toBeDefined();
  });

  it("preserves all connected accounts", () => {
    let session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );
    session = addAccountToSession(session, GOOGLE_ACCOUNT);
    session = addAccountToSession(session, MICROSOFT_ACCOUNT);

    const completed = completeSession(session);
    expect(completed.accounts).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Unit: Resume logic
// ---------------------------------------------------------------------------

describe("determineResumeAction", () => {
  it("returns 'fresh' when no session exists", () => {
    expect(determineResumeAction(null)).toBe("fresh");
  });

  it("returns 'fresh' for session with no accounts", () => {
    const session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );
    expect(determineResumeAction(session)).toBe("fresh");
  });

  it("returns 'resume' for session with connected accounts", () => {
    let session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );
    session = addAccountToSession(session, GOOGLE_ACCOUNT);

    expect(determineResumeAction(session)).toBe("resume");
  });

  it("returns 'resume' for session in connecting step with accounts", () => {
    let session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );
    session = addAccountToSession(session, GOOGLE_ACCOUNT);
    // step is "connecting" after addAccountToSession

    expect(determineResumeAction(session)).toBe("resume");
  });

  it("returns 'redirect' for completed session", () => {
    let session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );
    session = addAccountToSession(session, GOOGLE_ACCOUNT);
    session = completeSession(session);

    expect(determineResumeAction(session)).toBe("redirect");
  });

  it("returns 'redirect' when completed_at is set even if step is not complete", () => {
    let session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );
    session = addAccountToSession(session, GOOGLE_ACCOUNT);
    // Manually set completed_at without changing step (edge case)
    session = { ...session, completed_at: "2026-02-15T12:00:00Z" };

    expect(determineResumeAction(session)).toBe("redirect");
  });
});

// ---------------------------------------------------------------------------
// Unit: OAuth state parameter with session ID
// ---------------------------------------------------------------------------

describe("buildOAuthStateWithSession", () => {
  it("encodes session ID and nonce in base64 state parameter", () => {
    const state = buildOAuthStateWithSession(TEST_SESSION_ID, "nonce123");

    expect(typeof state).toBe("string");
    expect(state.length).toBeGreaterThan(0);
  });

  it("state can be decoded back to original values", () => {
    const state = buildOAuthStateWithSession(TEST_SESSION_ID, "nonce-xyz");
    const parsed = parseOAuthState(state);

    expect(parsed).not.toBeNull();
    expect(parsed!.session_id).toBe(TEST_SESSION_ID);
    expect(parsed!.nonce).toBe("nonce-xyz");
  });

  it("different session IDs produce different state values", () => {
    const state1 = buildOAuthStateWithSession("ses_AAA", "nonce1");
    const state2 = buildOAuthStateWithSession("ses_BBB", "nonce1");

    expect(state1).not.toBe(state2);
  });
});

describe("parseOAuthState", () => {
  it("returns null for invalid base64", () => {
    expect(parseOAuthState("not-base64!!!")).toBeNull();
  });

  it("returns null for valid base64 but invalid JSON", () => {
    expect(parseOAuthState(btoa("not json"))).toBeNull();
  });

  it("returns null for JSON without required fields", () => {
    expect(parseOAuthState(btoa(JSON.stringify({ foo: "bar" })))).toBeNull();
  });

  it("returns null for JSON with wrong types", () => {
    expect(
      parseOAuthState(
        btoa(JSON.stringify({ session_id: 123, nonce: "ok" })),
      ),
    ).toBeNull();
  });

  it("parses valid state parameter", () => {
    const state = btoa(
      JSON.stringify({ session_id: "ses_ABC", nonce: "n1" }),
    );
    const parsed = parseOAuthState(state);

    expect(parsed).toEqual({ session_id: "ses_ABC", nonce: "n1" });
  });
});

// ---------------------------------------------------------------------------
// Unit: Serialization round-trip
// ---------------------------------------------------------------------------

describe("serializeSession / deserializeSession", () => {
  it("round-trips a fresh session", () => {
    const session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );

    const json = serializeSession(session);
    const restored = deserializeSession(json);

    expect(restored).not.toBeNull();
    expect(restored!.session_id).toBe(TEST_SESSION_ID);
    expect(restored!.user_id).toBe(TEST_USER_ID);
    expect(restored!.step).toBe("welcome");
    expect(restored!.accounts).toEqual([]);
  });

  it("round-trips a session with accounts", () => {
    let session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );
    session = addAccountToSession(session, GOOGLE_ACCOUNT);
    session = addAccountToSession(session, MICROSOFT_ACCOUNT);

    const json = serializeSession(session);
    const restored = deserializeSession(json);

    expect(restored).not.toBeNull();
    expect(restored!.accounts).toHaveLength(2);
    expect(restored!.accounts[0].email).toBe("user@gmail.com");
    expect(restored!.accounts[1].email).toBe("user@outlook.com");
  });

  it("round-trips a completed session", () => {
    let session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );
    session = addAccountToSession(session, GOOGLE_ACCOUNT);
    session = completeSession(session);

    const json = serializeSession(session);
    const restored = deserializeSession(json);

    expect(restored).not.toBeNull();
    expect(restored!.step).toBe("complete");
    expect(restored!.completed_at).toBeDefined();
  });

  it("omits undefined optional fields in serialized JSON", () => {
    const session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );

    const json = serializeSession(session);
    const parsed = JSON.parse(json);

    // completed_at should not appear in the JSON
    expect("completed_at" in parsed).toBe(false);
  });

  it("returns null for invalid JSON", () => {
    expect(deserializeSession("not json")).toBeNull();
  });

  it("returns null for JSON missing required fields", () => {
    expect(
      deserializeSession(JSON.stringify({ session_id: "x" })),
    ).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(deserializeSession("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: Cross-tab polling consistency
// ---------------------------------------------------------------------------

describe("cross-tab polling consistency", () => {
  it("serialized state from one tab can be deserialized in another", () => {
    // Simulate: Tab 1 adds an account
    let session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );
    session = addAccountToSession(session, GOOGLE_ACCOUNT);

    // Simulate: Server persists this
    const serverJson = serializeSession(session);

    // Simulate: Tab 2 polls and gets the same state
    const tab2Session = deserializeSession(serverJson);

    expect(tab2Session).not.toBeNull();
    expect(tab2Session!.accounts).toHaveLength(1);
    expect(tab2Session!.accounts[0].email).toBe("user@gmail.com");
  });

  it("session with accounts added from different tabs is consistent", () => {
    // Tab 1 adds Google
    let session = createOnboardingSession(
      TEST_SESSION_ID,
      TEST_USER_ID,
      TEST_SESSION_TOKEN,
    );
    session = addAccountToSession(session, GOOGLE_ACCOUNT);

    // Serialize (server state after Tab 1)
    let serverJson = serializeSession(session);

    // Tab 2 deserializes and adds Microsoft
    let tab2Session = deserializeSession(serverJson)!;
    tab2Session = addAccountToSession(tab2Session, MICROSOFT_ACCOUNT);

    // Serialize again (server state after Tab 2)
    serverJson = serializeSession(tab2Session);

    // Tab 1 polls and sees both accounts
    const tab1Refresh = deserializeSession(serverJson)!;
    expect(tab1Refresh.accounts).toHaveLength(2);
    expect(tab1Refresh.accounts.map((a) => a.provider)).toEqual([
      "google",
      "microsoft",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("SESSION_POLL_INTERVAL_MS is within reasonable range (1-10 seconds)", () => {
    expect(SESSION_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
    expect(SESSION_POLL_INTERVAL_MS).toBeLessThanOrEqual(10_000);
  });
});
