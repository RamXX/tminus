/**
 * OnboardingWorkflow -- orchestrates the initial account setup flow.
 *
 * Runs after a new Google account is linked via OAuth. Steps:
 * 1. Fetch calendar list, identify primary, create busy overlay calendar
 * 2. Paginated full event sync (classify, normalize, apply deltas)
 * 3. Register watch channel with Google
 * 4. Store initial syncToken in AccountDO
 * 5. Mark account active in D1
 * 6. Create default bidirectional BUSY policy edges
 * 7. Project existing canonical events to new account
 *
 * Error handling: if any step fails, the account is marked with error status
 * in D1 and the error is logged. The workflow can be retried manually.
 *
 * Follows the same injectable-dependency pattern as sync-consumer for
 * testability: Google API via injectable FetchFn, DOs via fetch stubs.
 */

import {
  GoogleCalendarClient,
  classifyEvent,
  normalizeGoogleEvent,
  BUSY_OVERLAY_CALENDAR_NAME,
  generateId,
} from "@tminus/shared";
import type {
  GoogleCalendarEvent,
  ProviderDelta,
  AccountId,
  FetchFn,
  CalendarListEntry,
  WatchResponse,
} from "@tminus/shared";

// ---------------------------------------------------------------------------
// Env bindings (matches wrangler.toml)
// ---------------------------------------------------------------------------

export interface OnboardingEnv {
  USER_GRAPH: DurableObjectNamespace;
  ACCOUNT: DurableObjectNamespace;
  DB: D1Database;
  WRITE_QUEUE: Queue;
  WEBHOOK_URL: string;
}

// ---------------------------------------------------------------------------
// Workflow parameters
// ---------------------------------------------------------------------------

/** Input parameters for the onboarding workflow. */
export interface OnboardingParams {
  readonly account_id: AccountId;
  readonly user_id: string;
}

// ---------------------------------------------------------------------------
// Injectable dependencies (for testability)
// ---------------------------------------------------------------------------

export interface OnboardingDeps {
  /** Fetch function for GoogleCalendarClient (injectable for mocking Google API). */
  fetchFn?: FetchFn;
}

// ---------------------------------------------------------------------------
// Step result types
// ---------------------------------------------------------------------------

/** Result of step 1: calendar setup. */
export interface CalendarSetupResult {
  readonly primaryCalendarId: string;
  readonly overlayCalendarId: string;
  readonly allCalendars: CalendarListEntry[];
}

/** Result of step 2: full event sync. */
export interface EventSyncResult {
  readonly totalEvents: number;
  readonly totalDeltas: number;
  readonly syncToken: string | null;
  readonly pagesProcessed: number;
}

/** Result of step 3: watch channel registration. */
export interface WatchRegistrationResult {
  readonly channelId: string;
  readonly resourceId: string;
  readonly expiration: string;
  readonly token: string;
}

/** Complete onboarding result. */
export interface OnboardingResult {
  readonly calendarSetup: CalendarSetupResult;
  readonly eventSync: EventSyncResult;
  readonly watchRegistration: WatchRegistrationResult;
  readonly policyEdgesCreated: boolean;
  readonly projectionEnqueued: boolean;
  readonly accountActivated: boolean;
}

// ---------------------------------------------------------------------------
// OnboardingWorkflow class
// ---------------------------------------------------------------------------

/**
 * OnboardingWorkflow orchestrates the full onboarding sequence for a new
 * Google Calendar account.
 *
 * In production, each step would be a Workflow step (ctx.step.do()).
 * For testability, the logic is implemented as a plain class with
 * injectable dependencies, following the same pattern as sync-consumer.
 */
export class OnboardingWorkflow {
  private readonly env: OnboardingEnv;
  private readonly deps: OnboardingDeps;

  constructor(env: OnboardingEnv, deps: OnboardingDeps = {}) {
    this.env = env;
    this.deps = deps;
  }

  /**
   * Run the full onboarding flow for a newly linked account.
   *
   * Steps execute sequentially (each depends on the prior).
   * If any step fails, the account is marked with error status in D1
   * and the error is re-thrown for the Workflow runtime to handle retry.
   */
  async run(params: OnboardingParams): Promise<OnboardingResult> {
    const { account_id, user_id } = params;

    try {
      // Step 1: Get access token from AccountDO
      const accessToken = await this.getAccessToken(account_id);
      const client = new GoogleCalendarClient(accessToken, this.deps.fetchFn);

      // Step 2: Fetch calendar list and create overlay calendar
      const calendarSetup = await this.setupCalendars(
        client,
        account_id,
        user_id,
      );

      // Step 3: Full event sync (paginated)
      const eventSync = await this.fullEventSync(
        client,
        calendarSetup.primaryCalendarId,
        account_id,
        user_id,
      );

      // Step 4: Register watch channel
      const watchRegistration = await this.registerWatchChannel(
        client,
        calendarSetup.primaryCalendarId,
        account_id,
      );

      // Step 5: Store syncToken in AccountDO
      if (eventSync.syncToken) {
        await this.setSyncToken(account_id, eventSync.syncToken);
      }

      // Step 6: Mark account active in D1 + store channel_id
      await this.activateAccount(
        account_id,
        watchRegistration.channelId,
        watchRegistration.token,
        watchRegistration.expiration,
      );
      const accountActivated = true;

      // Step 7: Create default bidirectional BUSY policy edges
      const policyEdgesCreated = await this.createDefaultPolicyEdges(
        account_id,
        user_id,
      );

      // Step 8: Project existing canonical events to the new account
      const projectionEnqueued = await this.projectExistingEvents(user_id);

      return {
        calendarSetup,
        eventSync,
        watchRegistration,
        policyEdgesCreated,
        projectionEnqueued,
        accountActivated,
      };
    } catch (err) {
      // Mark account as error in D1
      await this.markAccountError(account_id).catch((markErr) => {
        console.error("Failed to mark account error:", markErr);
      });
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Step 1: Calendar setup
  // -------------------------------------------------------------------------

  /**
   * Fetch calendar list, identify primary, create busy overlay calendar,
   * and store calendar IDs in UserGraphDO.
   */
  async setupCalendars(
    client: GoogleCalendarClient,
    accountId: AccountId,
    userId: string,
  ): Promise<CalendarSetupResult> {
    // Fetch all calendars
    const calendars = await client.listCalendars();

    // Find primary calendar
    const primary = calendars.find((c) => c.primary === true);
    if (!primary) {
      throw new Error(
        `No primary calendar found for account ${accountId}`,
      );
    }

    // Create the busy overlay calendar
    const overlayCalendarId = await client.insertCalendar(
      BUSY_OVERLAY_CALENDAR_NAME,
    );

    // Store calendar entries in UserGraphDO
    const userGraphId = this.env.USER_GRAPH.idFromName(userId);
    const userGraphStub = this.env.USER_GRAPH.get(userGraphId);

    const storeResponse = await userGraphStub.fetch(
      new Request("https://user-graph.internal/storeCalendars", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          calendars: [
            {
              account_id: accountId,
              provider_calendar_id: primary.id,
              role: "primary",
              kind: "PRIMARY",
              display_name: primary.summary,
            },
            {
              account_id: accountId,
              provider_calendar_id: overlayCalendarId,
              role: "overlay",
              kind: "BUSY_OVERLAY",
              display_name: BUSY_OVERLAY_CALENDAR_NAME,
            },
          ],
        }),
      }),
    );

    if (!storeResponse.ok) {
      const body = await storeResponse.text();
      throw new Error(
        `UserGraphDO.storeCalendars failed (${storeResponse.status}): ${body}`,
      );
    }

    return {
      primaryCalendarId: primary.id,
      overlayCalendarId,
      allCalendars: calendars,
    };
  }

  // -------------------------------------------------------------------------
  // Step 2: Full event sync
  // -------------------------------------------------------------------------

  /**
   * Paginate through all events on the primary calendar.
   * Classify, normalize, and apply deltas to UserGraphDO.
   */
  async fullEventSync(
    client: GoogleCalendarClient,
    primaryCalendarId: string,
    accountId: AccountId,
    userId: string,
  ): Promise<EventSyncResult> {
    let pageToken: string | undefined;
    let syncToken: string | null = null;
    let totalEvents = 0;
    let totalDeltas = 0;
    let pagesProcessed = 0;

    do {
      const response = await client.listEvents(
        primaryCalendarId,
        undefined, // no syncToken for full sync
        pageToken,
      );

      totalEvents += response.events.length;
      pagesProcessed++;

      // Classify and normalize events
      const deltas = this.classifyAndNormalize(response.events, accountId);
      totalDeltas += deltas.length;

      // Apply deltas to UserGraphDO (per page, to avoid excessive memory)
      if (deltas.length > 0) {
        await this.applyDeltas(accountId, userId, deltas);
      }

      pageToken = response.nextPageToken;
      if (response.nextSyncToken) {
        syncToken = response.nextSyncToken;
      }
    } while (pageToken);

    return {
      totalEvents,
      totalDeltas,
      syncToken,
      pagesProcessed,
    };
  }

  // -------------------------------------------------------------------------
  // Step 3: Watch channel registration
  // -------------------------------------------------------------------------

  /**
   * Generate channel ID and token, register with Google, store in AccountDO.
   */
  async registerWatchChannel(
    client: GoogleCalendarClient,
    primaryCalendarId: string,
    accountId: AccountId,
  ): Promise<WatchRegistrationResult> {
    // Generate a unique channel ID and validation token
    const channelId = generateId("calendar");
    const token = generateId("calendar"); // Secure random token for validation

    const webhookUrl = this.env.WEBHOOK_URL;

    // Register with Google
    const watchResponse: WatchResponse = await client.watchEvents(
      primaryCalendarId,
      webhookUrl,
      channelId,
      token,
    );

    // Store in AccountDO
    await this.storeWatchChannel(
      accountId,
      watchResponse.channelId,
      watchResponse.resourceId,
      watchResponse.expiration,
      primaryCalendarId,
    );

    return {
      channelId: watchResponse.channelId,
      resourceId: watchResponse.resourceId,
      expiration: watchResponse.expiration,
      token,
    };
  }

  // -------------------------------------------------------------------------
  // Step 6: Default policy edges
  // -------------------------------------------------------------------------

  /**
   * Create default bidirectional BUSY policy edges between the new account
   * and all existing accounts for this user.
   */
  async createDefaultPolicyEdges(
    newAccountId: AccountId,
    userId: string,
  ): Promise<boolean> {
    // Look up all accounts for this user from D1
    const result = await this.env.DB.prepare(
      "SELECT account_id FROM accounts WHERE user_id = ?1",
    )
      .bind(userId)
      .all<{ account_id: string }>();

    const allAccountIds = result.results.map((r) => r.account_id);

    if (allAccountIds.length < 2) {
      // Only the new account exists; no edges needed yet
      return false;
    }

    // Call UserGraphDO.ensureDefaultPolicy with all accounts
    const userGraphId = this.env.USER_GRAPH.idFromName(userId);
    const userGraphStub = this.env.USER_GRAPH.get(userGraphId);

    const response = await userGraphStub.fetch(
      new Request("https://user-graph.internal/ensureDefaultPolicy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts: allAccountIds }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `UserGraphDO.ensureDefaultPolicy failed (${response.status}): ${body}`,
      );
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Step 7: Project existing events to new account
  // -------------------------------------------------------------------------

  /**
   * Trigger recomputation of projections for all existing canonical events.
   * This will enqueue UPSERT_MIRROR for events that now need to be mirrored
   * to the new account.
   */
  async projectExistingEvents(userId: string): Promise<boolean> {
    const userGraphId = this.env.USER_GRAPH.idFromName(userId);
    const userGraphStub = this.env.USER_GRAPH.get(userGraphId);

    const response = await userGraphStub.fetch(
      new Request("https://user-graph.internal/recomputeProjections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `UserGraphDO.recomputeProjections failed (${response.status}): ${body}`,
      );
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Helper: Classify and normalize events
  // -------------------------------------------------------------------------

  /**
   * Classify events and normalize origin events to ProviderDelta.
   * Managed mirrors are filtered out (Invariant E).
   */
  classifyAndNormalize(
    events: GoogleCalendarEvent[],
    accountId: AccountId,
  ): ProviderDelta[] {
    const deltas: ProviderDelta[] = [];

    for (const event of events) {
      const classification = classifyEvent(event);

      if (classification === "managed_mirror") {
        // Invariant E: managed mirrors are NOT treated as new origins.
        continue;
      }

      const delta = normalizeGoogleEvent(event, accountId, classification);
      deltas.push(delta);
    }

    return deltas;
  }

  // -------------------------------------------------------------------------
  // Helper: Apply deltas to UserGraphDO
  // -------------------------------------------------------------------------

  private async applyDeltas(
    accountId: AccountId,
    userId: string,
    deltas: ProviderDelta[],
  ): Promise<void> {
    const userGraphId = this.env.USER_GRAPH.idFromName(userId);
    const userGraphStub = this.env.USER_GRAPH.get(userGraphId);

    const response = await userGraphStub.fetch(
      new Request("https://user-graph.internal/applyProviderDelta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: accountId, deltas }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `UserGraphDO.applyProviderDelta failed (${response.status}): ${body}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Helper: AccountDO interactions
  // -------------------------------------------------------------------------

  private async getAccessToken(accountId: AccountId): Promise<string> {
    const doId = this.env.ACCOUNT.idFromName(accountId);
    const stub = this.env.ACCOUNT.get(doId);

    const response = await stub.fetch(
      new Request("https://account.internal/getAccessToken", {
        method: "POST",
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `AccountDO.getAccessToken failed (${response.status}): ${body}`,
      );
    }

    const data = (await response.json()) as { access_token: string };
    return data.access_token;
  }

  private async setSyncToken(
    accountId: AccountId,
    token: string,
  ): Promise<void> {
    const doId = this.env.ACCOUNT.idFromName(accountId);
    const stub = this.env.ACCOUNT.get(doId);

    const response = await stub.fetch(
      new Request("https://account.internal/setSyncToken", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sync_token: token }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `AccountDO.setSyncToken failed (${response.status}): ${body}`,
      );
    }
  }

  private async storeWatchChannel(
    accountId: AccountId,
    channelId: string,
    resourceId: string,
    expiration: string,
    calendarId: string,
  ): Promise<void> {
    const doId = this.env.ACCOUNT.idFromName(accountId);
    const stub = this.env.ACCOUNT.get(doId);

    const response = await stub.fetch(
      new Request("https://account.internal/storeWatchChannel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel_id: channelId,
          resource_id: resourceId,
          expiration,
          calendar_id: calendarId,
        }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `AccountDO.storeWatchChannel failed (${response.status}): ${body}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Helper: D1 interactions
  // -------------------------------------------------------------------------

  /**
   * Mark account as active in D1 and store channel info.
   */
  private async activateAccount(
    accountId: AccountId,
    channelId: string,
    channelToken: string,
    channelExpiry: string,
  ): Promise<void> {
    // Convert Google's millisecond timestamp to ISO string
    const expiryTs = new Date(parseInt(channelExpiry, 10)).toISOString();

    await this.env.DB.prepare(
      `UPDATE accounts
       SET status = 'active', channel_id = ?1, channel_token = ?2, channel_expiry_ts = ?3
       WHERE account_id = ?4`,
    )
      .bind(channelId, channelToken, expiryTs, accountId)
      .run();
  }

  /**
   * Mark account as error in D1. Best-effort -- does not throw.
   */
  private async markAccountError(accountId: AccountId): Promise<void> {
    await this.env.DB.prepare(
      "UPDATE accounts SET status = 'error' WHERE account_id = ?1",
    )
      .bind(accountId)
      .run();
  }
}
