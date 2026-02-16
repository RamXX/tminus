/**
 * Onboarding session management mixin for UserGraphDO.
 *
 * Extracted from UserGraphDO to reduce class size. Contains all methods
 * related to the Phase 6A onboarding session lifecycle:
 * - create / get / get-by-token
 * - add account / update account status
 * - complete session
 *
 * Uses composition: the mixin receives the sql handle and a migration
 * callback from the host DO, so it can operate on the same SQLite store.
 */

import type { SqlStorageLike } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Row shape for onboarding_sessions table. */
export interface OnboardingSessionRow {
  [key: string]: unknown;
  session_id: string;
  user_id: string;
  step: string;
  accounts_json: string;
  session_token: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/** Shape of an account entry stored in accounts_json. */
export interface OnboardingAccount {
  account_id: string;
  provider: string;
  email: string;
  status: string;
  calendar_count?: number;
  connected_at: string;
}

// ---------------------------------------------------------------------------
// Mixin class
// ---------------------------------------------------------------------------

/**
 * Encapsulates onboarding session persistence logic.
 *
 * Constructed with a reference to the DO's SqlStorageLike handle and a
 * callback that ensures migrations have been applied. This avoids
 * duplicating migration logic while keeping the onboarding code isolated.
 */
export class OnboardingSessionMixin {
  private readonly sql: SqlStorageLike;
  private readonly ensureMigrated: () => void;

  constructor(sql: SqlStorageLike, ensureMigrated: () => void) {
    this.sql = sql;
    this.ensureMigrated = ensureMigrated;
  }

  // -----------------------------------------------------------------------
  // Public API -- same signatures as the original UserGraphDO methods
  // -----------------------------------------------------------------------

  /**
   * Create a new onboarding session for a user.
   * BR-1: Session is per-user, stored in UserGraphDO.
   */
  createOnboardingSession(
    sessionId: string,
    userId: string,
    sessionToken: string,
  ): OnboardingSessionRow {
    this.ensureMigrated();
    const now = new Date().toISOString();

    this.sql.exec<Record<string, unknown>>(
      `INSERT INTO onboarding_sessions
         (session_id, user_id, step, accounts_json, session_token, created_at, updated_at)
       VALUES (?1, ?2, 'welcome', '[]', ?3, ?4, ?4)`,
      sessionId,
      userId,
      sessionToken,
      now,
    );

    return {
      session_id: sessionId,
      user_id: userId,
      step: "welcome",
      accounts_json: "[]",
      session_token: sessionToken,
      created_at: now,
      updated_at: now,
      completed_at: null,
    };
  }

  /**
   * Get the active onboarding session for a user.
   * Returns the most recent non-completed session, or null.
   */
  getOnboardingSession(userId: string): OnboardingSessionRow | null {
    this.ensureMigrated();

    const rows = this.sql
      .exec<OnboardingSessionRow>(
        `SELECT session_id, user_id, step, accounts_json, session_token,
                created_at, updated_at, completed_at
         FROM onboarding_sessions
         WHERE user_id = ?1
         ORDER BY created_at DESC
         LIMIT 1`,
        userId,
      )
      .toArray();

    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Get an onboarding session by session token.
   * BR-3: Session survives browser close (httpOnly cookie + server state).
   */
  getOnboardingSessionByToken(sessionToken: string): OnboardingSessionRow | null {
    this.ensureMigrated();

    const rows = this.sql
      .exec<OnboardingSessionRow>(
        `SELECT session_id, user_id, step, accounts_json, session_token,
                created_at, updated_at, completed_at
         FROM onboarding_sessions
         WHERE session_token = ?1
         LIMIT 1`,
        sessionToken,
      )
      .toArray();

    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Add or update an account in the onboarding session.
   * BR-4: Adding same account is idempotent (update, not duplicate).
   */
  addOnboardingAccount(
    userId: string,
    account: OnboardingAccount,
  ): OnboardingSessionRow | null {
    this.ensureMigrated();

    const session = this.getOnboardingSession(userId);
    if (!session) return null;

    const accounts = JSON.parse(session.accounts_json) as OnboardingAccount[];

    // Idempotent: update existing or add new
    const existingIndex = accounts.findIndex(
      (a) => a.account_id === account.account_id,
    );
    if (existingIndex >= 0) {
      accounts[existingIndex] = account;
    } else {
      accounts.push(account);
    }

    const now = new Date().toISOString();
    const accountsJson = JSON.stringify(accounts);

    this.sql.exec<Record<string, unknown>>(
      `UPDATE onboarding_sessions
       SET accounts_json = ?1, step = 'connecting', updated_at = ?2
       WHERE session_id = ?3`,
      accountsJson,
      now,
      session.session_id,
    );

    return {
      ...session,
      accounts_json: accountsJson,
      step: "connecting",
      updated_at: now,
    };
  }

  /**
   * Update the status of an account in the onboarding session.
   */
  updateOnboardingAccountStatus(
    userId: string,
    accountId: string,
    status: string,
    calendarCount?: number,
  ): OnboardingSessionRow | null {
    this.ensureMigrated();

    const session = this.getOnboardingSession(userId);
    if (!session) return null;

    const accounts = JSON.parse(session.accounts_json) as OnboardingAccount[];

    const account = accounts.find((a) => a.account_id === accountId);
    if (account) {
      account.status = status;
      if (calendarCount !== undefined) {
        account.calendar_count = calendarCount;
      }
    }

    const now = new Date().toISOString();
    const accountsJson = JSON.stringify(accounts);

    this.sql.exec<Record<string, unknown>>(
      `UPDATE onboarding_sessions
       SET accounts_json = ?1, updated_at = ?2
       WHERE session_id = ?3`,
      accountsJson,
      now,
      session.session_id,
    );

    return {
      ...session,
      accounts_json: accountsJson,
      updated_at: now,
    };
  }

  /**
   * Mark onboarding session as complete.
   * AC 6: Session marked complete on explicit user action (not auto-timeout).
   */
  completeOnboardingSession(userId: string): OnboardingSessionRow | null {
    this.ensureMigrated();

    const session = this.getOnboardingSession(userId);
    if (!session) return null;

    const now = new Date().toISOString();

    this.sql.exec<Record<string, unknown>>(
      `UPDATE onboarding_sessions
       SET step = 'complete', completed_at = ?1, updated_at = ?1
       WHERE session_id = ?2`,
      now,
      session.session_id,
    );

    return {
      ...session,
      step: "complete",
      completed_at: now,
      updated_at: now,
    };
  }
}
