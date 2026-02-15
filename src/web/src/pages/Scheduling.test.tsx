/**
 * Tests for the Scheduling page.
 *
 * Covers:
 * - Unit: propose meeting form fields, candidate list rendering, active
 *   sessions display, status badges
 * - Integration: form submission creates session via API, commit button
 *   calls commit API, cancel button calls cancel API, sessions load on mount
 *
 * Uses React Testing Library with fireEvent for click interactions.
 * Same pattern as Billing.test.tsx, ErrorRecovery.test.tsx.
 *
 * NOTE: We use fireEvent.click instead of userEvent.click because components
 * with timers interact poorly with userEvent's internal delay mechanism
 * under fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import { Scheduling, type SchedulingProps } from "./Scheduling";
import type {
  SchedulingSession,
  SchedulingCandidate,
  CommitResponse,
  CancelResponse,
  SessionParticipant,
} from "../lib/scheduling";
import type { LinkedAccount } from "../lib/api";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MOCK_ACCOUNTS: LinkedAccount[] = [
  { account_id: "acc_1", email: "work@example.com", provider: "google", status: "active" },
  { account_id: "acc_2", email: "personal@example.com", provider: "google", status: "active" },
  { account_id: "acc_3", email: "side@example.com", provider: "microsoft", status: "active" },
];

const MOCK_CANDIDATES: SchedulingCandidate[] = [
  {
    candidate_id: "cand_1",
    start: "2026-02-20T10:00:00Z",
    end: "2026-02-20T10:30:00Z",
    score: 0.95,
    explanation: "No conflicts, preferred morning slot",
  },
  {
    candidate_id: "cand_2",
    start: "2026-02-20T14:00:00Z",
    end: "2026-02-20T14:30:00Z",
    score: 0.82,
    explanation: "Adjacent to existing meeting",
  },
  {
    candidate_id: "cand_3",
    start: "2026-02-21T09:00:00Z",
    end: "2026-02-21T09:30:00Z",
    score: 0.7,
    explanation: "Different day, less optimal",
  },
];

const MOCK_SESSION_PENDING: SchedulingSession = {
  session_id: "sess_001",
  status: "pending",
  duration_minutes: 30,
  window_start: "2026-02-20T00:00:00Z",
  window_end: "2026-02-22T00:00:00Z",
  participants: [
    { account_id: "acc_1", email: "work@example.com" },
    { account_id: "acc_2", email: "personal@example.com" },
  ],
  constraints: {
    avoid_early_morning: false,
    avoid_late_evening: true,
    prefer_existing_gaps: true,
  },
  candidates: [],
  created_at: "2026-02-15T10:00:00Z",
  updated_at: "2026-02-15T10:00:00Z",
};

const MOCK_SESSION_READY: SchedulingSession = {
  session_id: "sess_002",
  status: "candidates_ready",
  duration_minutes: 30,
  window_start: "2026-02-20T00:00:00Z",
  window_end: "2026-02-22T00:00:00Z",
  participants: [
    { account_id: "acc_1", email: "work@example.com" },
    { account_id: "acc_2", email: "personal@example.com" },
  ],
  constraints: {
    avoid_early_morning: false,
    avoid_late_evening: true,
    prefer_existing_gaps: true,
  },
  candidates: MOCK_CANDIDATES,
  created_at: "2026-02-15T10:00:00Z",
  updated_at: "2026-02-15T10:05:00Z",
};

const MOCK_SESSION_COMMITTED: SchedulingSession = {
  session_id: "sess_003",
  status: "committed",
  duration_minutes: 60,
  window_start: "2026-02-20T00:00:00Z",
  window_end: "2026-02-22T00:00:00Z",
  participants: [{ account_id: "acc_1", email: "work@example.com" }],
  constraints: {
    avoid_early_morning: true,
    avoid_late_evening: true,
    prefer_existing_gaps: true,
  },
  candidates: MOCK_CANDIDATES.slice(0, 1),
  created_at: "2026-02-15T09:00:00Z",
  updated_at: "2026-02-15T09:10:00Z",
};

const MOCK_SESSION_CANCELLED: SchedulingSession = {
  session_id: "sess_004",
  status: "cancelled",
  duration_minutes: 45,
  window_start: "2026-02-20T00:00:00Z",
  window_end: "2026-02-22T00:00:00Z",
  participants: [{ account_id: "acc_2", email: "personal@example.com" }],
  constraints: {
    avoid_early_morning: false,
    avoid_late_evening: false,
    prefer_existing_gaps: false,
  },
  candidates: [],
  created_at: "2026-02-15T08:00:00Z",
  updated_at: "2026-02-15T08:30:00Z",
};

const ALL_MOCK_SESSIONS: SchedulingSession[] = [
  MOCK_SESSION_PENDING,
  MOCK_SESSION_READY,
  MOCK_SESSION_COMMITTED,
  MOCK_SESSION_CANCELLED,
];

const MOCK_COMMIT_RESPONSE: CommitResponse = {
  session_id: "sess_002",
  event_id: "evt_abc123",
  status: "committed",
};

const MOCK_CANCEL_RESPONSE: CancelResponse = {
  session_id: "sess_001",
  status: "cancelled",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockListSessions(sessions: SchedulingSession[] = ALL_MOCK_SESSIONS) {
  return vi.fn(async (): Promise<SchedulingSession[]> => sessions);
}

function createFailingListSessions(message = "Network error") {
  return vi.fn(async (): Promise<SchedulingSession[]> => {
    throw new Error(message);
  });
}

function createMockFetchAccounts(accounts: LinkedAccount[] = MOCK_ACCOUNTS) {
  return vi.fn(async (): Promise<LinkedAccount[]> => accounts);
}

function createMockCreateSession(session: SchedulingSession = MOCK_SESSION_PENDING) {
  return vi.fn(async (): Promise<SchedulingSession> => session);
}

function createMockCommitCandidate(response: CommitResponse = MOCK_COMMIT_RESPONSE) {
  return vi.fn(async (): Promise<CommitResponse> => response);
}

function createMockCancelSession(response: CancelResponse = MOCK_CANCEL_RESPONSE) {
  return vi.fn(async (): Promise<CancelResponse> => response);
}

/**
 * Render the Scheduling component and wait for the initial async fetch to resolve.
 */
async function renderAndWait(overrides: Partial<SchedulingProps> = {}) {
  const listSessions = overrides.listSessions ?? createMockListSessions();
  const fetchAccounts = overrides.fetchAccounts ?? createMockFetchAccounts();
  const createSession = overrides.createSession ?? createMockCreateSession();
  const commitCandidate = overrides.commitCandidate ?? createMockCommitCandidate();
  const cancelSession = overrides.cancelSession ?? createMockCancelSession();

  const result = render(
    <Scheduling
      listSessions={listSessions}
      fetchAccounts={fetchAccounts}
      createSession={createSession}
      commitCandidate={commitCandidate}
      cancelSession={cancelSession}
    />,
  );

  // Flush microtasks so async fetch resolves
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  return {
    ...result,
    listSessions,
    fetchAccounts,
    createSession,
    commitCandidate,
    cancelSession,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Scheduling Page", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-02-15T12:00:00Z").getTime() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Unit Tests: Propose Meeting Form Fields (AC#1)
  // =========================================================================

  describe("propose meeting form", () => {
    it("renders duration picker", async () => {
      await renderAndWait();

      const durationSelect = screen.getByTestId("duration-select");
      expect(durationSelect).toBeInTheDocument();
      expect(durationSelect.tagName).toBe("SELECT");
    });

    it("renders date range inputs for window", async () => {
      await renderAndWait();

      expect(screen.getByTestId("window-start")).toBeInTheDocument();
      expect(screen.getByTestId("window-end")).toBeInTheDocument();
    });

    it("renders participant selector with accounts from API", async () => {
      await renderAndWait({
        fetchAccounts: createMockFetchAccounts(MOCK_ACCOUNTS),
      });

      // Should show checkboxes for each account
      expect(screen.getByTestId("participant-acc_1")).toBeInTheDocument();
      expect(screen.getByTestId("participant-acc_2")).toBeInTheDocument();
      expect(screen.getByTestId("participant-acc_3")).toBeInTheDocument();
    });

    it("renders constraint toggles", async () => {
      await renderAndWait();

      expect(screen.getByTestId("constraint-avoid-early-morning")).toBeInTheDocument();
      expect(screen.getByTestId("constraint-avoid-late-evening")).toBeInTheDocument();
      expect(screen.getByTestId("constraint-prefer-existing-gaps")).toBeInTheDocument();
    });

    it("renders submit button", async () => {
      await renderAndWait();

      const submitBtn = screen.getByTestId("propose-meeting-btn");
      expect(submitBtn).toBeInTheDocument();
      expect(submitBtn).toHaveTextContent(/propose meeting/i);
    });

    it("shows duration options including 15, 30, 60 minutes", async () => {
      await renderAndWait();

      const durationSelect = screen.getByTestId("duration-select");
      const options = within(durationSelect).getAllByRole("option");
      const values = options.map((o) => o.getAttribute("value"));

      expect(values).toContain("15");
      expect(values).toContain("30");
      expect(values).toContain("60");
    });
  });

  // =========================================================================
  // Unit Tests: Candidate List with Scores (AC#2)
  // =========================================================================

  describe("candidate list", () => {
    it("renders candidates with scores and explanations", async () => {
      await renderAndWait({
        listSessions: createMockListSessions([MOCK_SESSION_READY]),
      });

      // Click the ready session to view details
      fireEvent.click(screen.getByTestId("session-row-sess_002"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("candidate-list")).toBeInTheDocument();

      const candidates = screen.getByTestId("candidate-list");
      expect(within(candidates).getByText("95%")).toBeInTheDocument();
      expect(within(candidates).getByText("82%")).toBeInTheDocument();
      expect(within(candidates).getByText("70%")).toBeInTheDocument();
    });

    it("highlights best candidate", async () => {
      await renderAndWait({
        listSessions: createMockListSessions([MOCK_SESSION_READY]),
      });

      fireEvent.click(screen.getByTestId("session-row-sess_002"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const bestCandidate = screen.getByTestId("candidate-cand_1");
      expect(bestCandidate).toHaveAttribute("data-best", "true");
    });

    it("shows explanations for each candidate", async () => {
      await renderAndWait({
        listSessions: createMockListSessions([MOCK_SESSION_READY]),
      });

      fireEvent.click(screen.getByTestId("session-row-sess_002"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByText("No conflicts, preferred morning slot")).toBeInTheDocument();
      expect(screen.getByText("Adjacent to existing meeting")).toBeInTheDocument();
    });

    it("shows commit button for each candidate in ready session", async () => {
      await renderAndWait({
        listSessions: createMockListSessions([MOCK_SESSION_READY]),
      });

      fireEvent.click(screen.getByTestId("session-row-sess_002"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("commit-btn-cand_1")).toBeInTheDocument();
      expect(screen.getByTestId("commit-btn-cand_2")).toBeInTheDocument();
      expect(screen.getByTestId("commit-btn-cand_3")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Unit Tests: Active Sessions with Status (AC#4)
  // =========================================================================

  describe("active sessions list", () => {
    it("renders session rows with status badges", async () => {
      await renderAndWait();

      expect(screen.getByTestId("session-row-sess_001")).toBeInTheDocument();
      expect(screen.getByTestId("session-row-sess_002")).toBeInTheDocument();
      expect(screen.getByTestId("session-row-sess_003")).toBeInTheDocument();
      expect(screen.getByTestId("session-row-sess_004")).toBeInTheDocument();
    });

    it("shows status badge text for each session", async () => {
      await renderAndWait();

      expect(screen.getByTestId("status-badge-sess_001")).toHaveTextContent("Pending");
      expect(screen.getByTestId("status-badge-sess_002")).toHaveTextContent("Ready");
      expect(screen.getByTestId("status-badge-sess_003")).toHaveTextContent("Committed");
      expect(screen.getByTestId("status-badge-sess_004")).toHaveTextContent("Cancelled");
    });

    it("shows cancel button only for pending and candidates_ready sessions (AC#5)", async () => {
      await renderAndWait();

      expect(screen.getByTestId("cancel-btn-sess_001")).toBeInTheDocument();
      expect(screen.getByTestId("cancel-btn-sess_002")).toBeInTheDocument();
      expect(screen.queryByTestId("cancel-btn-sess_003")).not.toBeInTheDocument();
      expect(screen.queryByTestId("cancel-btn-sess_004")).not.toBeInTheDocument();
    });

    it("shows duration for each session", async () => {
      await renderAndWait();

      const row1 = screen.getByTestId("session-row-sess_001");
      expect(within(row1).getByText(/30 min/)).toBeInTheDocument();

      const row3 = screen.getByTestId("session-row-sess_003");
      expect(within(row3).getByText(/60 min/)).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Integration: Load Sessions on Mount
  // =========================================================================

  describe("integration: load sessions on mount", () => {
    it("calls listSessions on mount", async () => {
      const listSessions = createMockListSessions();
      await renderAndWait({ listSessions });

      expect(listSessions).toHaveBeenCalledTimes(1);
    });

    it("calls fetchAccounts on mount for participant selector", async () => {
      const fetchAccounts = createMockFetchAccounts();
      await renderAndWait({ fetchAccounts });

      expect(fetchAccounts).toHaveBeenCalledTimes(1);
    });

    it("shows loading state before fetch completes", () => {
      const listSessions = vi.fn(
        (): Promise<SchedulingSession[]> => new Promise(() => {}),
      );
      render(
        <Scheduling
          listSessions={listSessions}
          fetchAccounts={createMockFetchAccounts()}
          createSession={createMockCreateSession()}
          commitCandidate={createMockCommitCandidate()}
          cancelSession={createMockCancelSession()}
        />,
      );

      expect(screen.getByTestId("scheduling-loading")).toBeInTheDocument();
    });

    it("shows error state when fetch fails", async () => {
      await renderAndWait({
        listSessions: createFailingListSessions("API unavailable"),
      });

      expect(screen.getByTestId("scheduling-error")).toBeInTheDocument();
      expect(screen.getByText(/api unavailable/i)).toBeInTheDocument();
    });

    it("shows retry button on error", async () => {
      await renderAndWait({
        listSessions: createFailingListSessions(),
      });

      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });

    it("retry button refetches sessions", async () => {
      const listSessions = createFailingListSessions();
      await renderAndWait({ listSessions });

      expect(listSessions).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: /retry/i }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(listSessions).toHaveBeenCalledTimes(2);
    });

    it("shows empty state when no sessions exist", async () => {
      await renderAndWait({
        listSessions: createMockListSessions([]),
      });

      expect(screen.getByTestId("sessions-empty")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Integration: Form Submission Creates Session (AC#1)
  // =========================================================================

  describe("integration: form submission creates session", () => {
    it("submitting form calls createSession with correct payload", async () => {
      const createSession = createMockCreateSession();
      await renderAndWait({ createSession });

      // Fill form: select duration
      fireEvent.change(screen.getByTestId("duration-select"), {
        target: { value: "30" },
      });

      // Set window dates
      fireEvent.change(screen.getByTestId("window-start"), {
        target: { value: "2026-02-20" },
      });
      fireEvent.change(screen.getByTestId("window-end"), {
        target: { value: "2026-02-22" },
      });

      // Select participants
      fireEvent.click(screen.getByTestId("participant-acc_1"));
      fireEvent.click(screen.getByTestId("participant-acc_2"));

      // Toggle a constraint
      fireEvent.click(screen.getByTestId("constraint-avoid-late-evening"));

      // Submit
      fireEvent.click(screen.getByTestId("propose-meeting-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(createSession).toHaveBeenCalledTimes(1);
      expect(createSession).toHaveBeenCalledWith({
        duration_minutes: 30,
        window_start: "2026-02-20",
        window_end: "2026-02-22",
        participant_account_ids: ["acc_1", "acc_2"],
        constraints: {
          avoid_early_morning: false,
          avoid_late_evening: true,
          prefer_existing_gaps: true,
        },
      });
    });

    it("shows success message after session creation", async () => {
      await renderAndWait();

      // Select a participant (required)
      fireEvent.click(screen.getByTestId("participant-acc_1"));

      // Set window dates
      fireEvent.change(screen.getByTestId("window-start"), {
        target: { value: "2026-02-20" },
      });
      fireEvent.change(screen.getByTestId("window-end"), {
        target: { value: "2026-02-22" },
      });

      fireEvent.click(screen.getByTestId("propose-meeting-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId("scheduling-status-msg")).toBeInTheDocument();
    });

    it("shows error message when session creation fails", async () => {
      const createSession = vi.fn(async () => {
        throw new Error("Scheduling conflict");
      });
      await renderAndWait({ createSession });

      // Select a participant
      fireEvent.click(screen.getByTestId("participant-acc_1"));

      // Set window dates
      fireEvent.change(screen.getByTestId("window-start"), {
        target: { value: "2026-02-20" },
      });
      fireEvent.change(screen.getByTestId("window-end"), {
        target: { value: "2026-02-22" },
      });

      fireEvent.click(screen.getByTestId("propose-meeting-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const statusMsg = screen.getByTestId("scheduling-status-msg");
      expect(statusMsg).toHaveTextContent(/scheduling conflict/i);
    });

    it("refreshes sessions list after successful creation", async () => {
      const listSessions = createMockListSessions();
      await renderAndWait({ listSessions });

      expect(listSessions).toHaveBeenCalledTimes(1);

      // Select a participant
      fireEvent.click(screen.getByTestId("participant-acc_1"));

      // Set window dates
      fireEvent.change(screen.getByTestId("window-start"), {
        target: { value: "2026-02-20" },
      });
      fireEvent.change(screen.getByTestId("window-end"), {
        target: { value: "2026-02-22" },
      });

      fireEvent.click(screen.getByTestId("propose-meeting-btn"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Should have been called again to refresh
      expect(listSessions).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Integration: Commit Button Creates Event (AC#3)
  // =========================================================================

  describe("integration: commit candidate creates event", () => {
    it("clicking commit calls commitCandidate with session and candidate IDs", async () => {
      const commitCandidate = createMockCommitCandidate();
      await renderAndWait({
        listSessions: createMockListSessions([MOCK_SESSION_READY]),
        commitCandidate,
      });

      // Click session to expand
      fireEvent.click(screen.getByTestId("session-row-sess_002"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Click commit on the best candidate
      fireEvent.click(screen.getByTestId("commit-btn-cand_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(commitCandidate).toHaveBeenCalledTimes(1);
      expect(commitCandidate).toHaveBeenCalledWith("sess_002", "cand_1");
    });

    it("shows success message after committing", async () => {
      await renderAndWait({
        listSessions: createMockListSessions([MOCK_SESSION_READY]),
      });

      fireEvent.click(screen.getByTestId("session-row-sess_002"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByTestId("commit-btn-cand_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const statusMsg = screen.getByTestId("scheduling-status-msg");
      expect(statusMsg).toHaveTextContent(/committed/i);
    });

    it("refreshes sessions after committing", async () => {
      const listSessions = createMockListSessions([MOCK_SESSION_READY]);
      await renderAndWait({ listSessions });

      expect(listSessions).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTestId("session-row-sess_002"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByTestId("commit-btn-cand_1"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(listSessions).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Integration: Cancel Button Releases Holds (AC#5)
  // =========================================================================

  describe("integration: cancel session", () => {
    it("clicking cancel calls cancelSession with session ID", async () => {
      const cancelSession = createMockCancelSession();
      await renderAndWait({ cancelSession });

      fireEvent.click(screen.getByTestId("cancel-btn-sess_001"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(cancelSession).toHaveBeenCalledTimes(1);
      expect(cancelSession).toHaveBeenCalledWith("sess_001");
    });

    it("shows success message after cancelling", async () => {
      await renderAndWait();

      fireEvent.click(screen.getByTestId("cancel-btn-sess_001"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const statusMsg = screen.getByTestId("scheduling-status-msg");
      expect(statusMsg).toHaveTextContent(/cancelled/i);
    });

    it("refreshes sessions after cancelling", async () => {
      const listSessions = createMockListSessions();
      await renderAndWait({ listSessions });

      expect(listSessions).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTestId("cancel-btn-sess_001"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(listSessions).toHaveBeenCalledTimes(2);
    });

    it("shows error message when cancel fails", async () => {
      const cancelSession = vi.fn(async () => {
        throw new Error("Cannot cancel committed session");
      });
      await renderAndWait({ cancelSession });

      fireEvent.click(screen.getByTestId("cancel-btn-sess_001"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const statusMsg = screen.getByTestId("scheduling-status-msg");
      expect(statusMsg).toHaveTextContent(/cannot cancel/i);
    });
  });

  // =========================================================================
  // Unit Tests: Responsive Design (AC#6)
  // =========================================================================

  describe("responsive design", () => {
    it("renders all major sections", async () => {
      await renderAndWait();

      // Title
      expect(screen.getByText("Scheduling")).toBeInTheDocument();
      // Back link
      expect(screen.getByText("Back to Calendar")).toBeInTheDocument();
      // Form section
      expect(screen.getByTestId("propose-form")).toBeInTheDocument();
      // Sessions section
      expect(screen.getByTestId("sessions-list")).toBeInTheDocument();
    });
  });
});
