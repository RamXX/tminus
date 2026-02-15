/**
 * Scheduling page.
 *
 * Provides a UI for proposing meetings, viewing candidate time slots with
 * scores, committing candidates to create events, and managing active
 * scheduling sessions.
 *
 * Features:
 * - Propose Meeting form: duration, date window, participant selector, constraints
 * - Candidate list: ranked by score with explanations, commit button per candidate
 * - Active sessions list: status badges, cancel button for pending/ready sessions
 * - Loading, error, empty, and status feedback states
 *
 * The component accepts fetch/action functions as props for testability.
 * In production, these are wired to the API client with auth tokens in App.tsx.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { LinkedAccount } from "../lib/api";
import type {
  SchedulingSession,
  SchedulingCandidate,
  CreateSessionPayload,
  CommitResponse,
  CancelResponse,
  SchedulingConstraints,
} from "../lib/scheduling";
import {
  statusLabel,
  statusColor,
  statusBgColor,
  formatScore,
  formatDateTime,
  defaultConstraints,
  DURATION_OPTIONS,
} from "../lib/scheduling";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SchedulingProps {
  /** List all scheduling sessions. Injected for testability. */
  listSessions: () => Promise<SchedulingSession[]>;
  /** Fetch linked accounts for participant selector. */
  fetchAccounts: () => Promise<LinkedAccount[]>;
  /** Create a new scheduling session. */
  createSession: (payload: CreateSessionPayload) => Promise<SchedulingSession>;
  /** Commit a candidate to create the event. */
  commitCandidate: (sessionId: string, candidateId: string) => Promise<CommitResponse>;
  /** Cancel a scheduling session. */
  cancelSession: (sessionId: string) => Promise<CancelResponse>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Scheduling({
  listSessions,
  fetchAccounts,
  createSession,
  commitCandidate,
  cancelSession,
}: SchedulingProps) {
  // -- State: data --
  const [sessions, setSessions] = useState<SchedulingSession[]>([]);
  const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // -- State: form --
  const [duration, setDuration] = useState(30);
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [selectedParticipants, setSelectedParticipants] = useState<Set<string>>(new Set());
  const [constraints, setConstraints] = useState<SchedulingConstraints>(defaultConstraints());
  const [submitting, setSubmitting] = useState(false);

  // -- State: session detail --
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);

  // -- State: status feedback --
  const [statusMsg, setStatusMsg] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const mountedRef = useRef(true);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Show a temporary status message that auto-clears after 4 seconds
  const showStatus = useCallback(
    (type: "success" | "error", text: string) => {
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current);
      }
      setStatusMsg({ type, text });
      statusTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          setStatusMsg(null);
        }
        statusTimerRef.current = null;
      }, 4000);
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Load data
  // -------------------------------------------------------------------------

  const loadSessions = useCallback(async () => {
    try {
      const result = await listSessions();
      if (!mountedRef.current) return;
      setSessions(result);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }, [listSessions]);

  const loadAccounts = useCallback(async () => {
    try {
      const result = await fetchAccounts();
      if (!mountedRef.current) return;
      setAccounts(result);
    } catch {
      // Non-critical -- participant selector will be empty
    }
  }, [fetchAccounts]);

  // Initial load
  useEffect(() => {
    mountedRef.current = true;
    loadSessions();
    loadAccounts();

    return () => {
      mountedRef.current = false;
      if (statusTimerRef.current) {
        clearTimeout(statusTimerRef.current);
      }
    };
  }, [loadSessions, loadAccounts]);

  // -------------------------------------------------------------------------
  // Form handlers
  // -------------------------------------------------------------------------

  const toggleParticipant = useCallback((accountId: string) => {
    setSelectedParticipants((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  }, []);

  const toggleConstraint = useCallback((key: keyof SchedulingConstraints) => {
    setConstraints((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (selectedParticipants.size === 0 || !windowStart || !windowEnd) return;

    setSubmitting(true);

    const payload: CreateSessionPayload = {
      duration_minutes: duration,
      window_start: windowStart,
      window_end: windowEnd,
      participant_account_ids: Array.from(selectedParticipants),
      constraints,
    };

    try {
      await createSession(payload);

      if (!mountedRef.current) return;

      showStatus("success", "Meeting proposal created successfully.");

      // Reset form
      setSelectedParticipants(new Set());
      setWindowStart("");
      setWindowEnd("");
      setConstraints(defaultConstraints());

      // Refresh sessions list
      await loadSessions();
    } catch (err) {
      if (!mountedRef.current) return;
      showStatus(
        "error",
        `Failed to create session: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    } finally {
      if (mountedRef.current) {
        setSubmitting(false);
      }
    }
  }, [
    duration,
    windowStart,
    windowEnd,
    selectedParticipants,
    constraints,
    createSession,
    loadSessions,
    showStatus,
  ]);

  // -------------------------------------------------------------------------
  // Session action handlers
  // -------------------------------------------------------------------------

  const handleCommit = useCallback(
    async (sessionId: string, candidateId: string) => {
      try {
        await commitCandidate(sessionId, candidateId);

        if (!mountedRef.current) return;

        showStatus("success", "Candidate committed. Event created.");
        setExpandedSessionId(null);

        // Refresh sessions
        await loadSessions();
      } catch (err) {
        if (!mountedRef.current) return;
        showStatus(
          "error",
          `Failed to commit: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
    [commitCandidate, loadSessions, showStatus],
  );

  const handleCancel = useCallback(
    async (sessionId: string) => {
      try {
        await cancelSession(sessionId);

        if (!mountedRef.current) return;

        showStatus("success", "Session cancelled.");

        // Refresh sessions
        await loadSessions();
      } catch (err) {
        if (!mountedRef.current) return;
        showStatus(
          "error",
          `Failed to cancel: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
    [cancelSession, loadSessions, showStatus],
  );

  const handleSessionClick = useCallback((sessionId: string) => {
    setExpandedSessionId((prev) => (prev === sessionId ? null : sessionId));
  }, []);

  // -------------------------------------------------------------------------
  // Render: Loading
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div data-testid="scheduling-loading" style={styles.container}>
        <h1 style={styles.title}>Scheduling</h1>
        <div style={styles.loading}>Loading scheduling sessions...</div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Error
  // -------------------------------------------------------------------------

  if (error) {
    return (
      <div data-testid="scheduling-error" style={styles.container}>
        <h1 style={styles.title}>Scheduling</h1>
        <div style={styles.errorBox}>
          <p>Failed to load sessions: {error}</p>
          <button
            onClick={loadSessions}
            style={styles.retryBtn}
            aria-label="Retry"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Main
  // -------------------------------------------------------------------------

  const expandedSession = sessions.find((s) => s.session_id === expandedSessionId) ?? null;

  return (
    <div style={styles.container}>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>Scheduling</h1>
        <a href="#/calendar" style={styles.backLink}>
          Back to Calendar
        </a>
      </div>

      {/* Status message */}
      {statusMsg && (
        <div
          data-testid="scheduling-status-msg"
          style={{
            ...styles.statusMessage,
            ...(statusMsg.type === "success"
              ? styles.statusSuccess
              : styles.statusError),
          }}
        >
          {statusMsg.text}
        </div>
      )}

      {/* Propose Meeting Form */}
      <div data-testid="propose-form" style={styles.formCard}>
        <h2 style={styles.sectionTitle}>Propose Meeting</h2>

        {/* Duration */}
        <div style={styles.formGroup}>
          <label htmlFor="duration-select" style={styles.label}>
            Duration
          </label>
          <select
            id="duration-select"
            data-testid="duration-select"
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            style={styles.select}
          >
            {DURATION_OPTIONS.map((mins) => (
              <option key={mins} value={mins}>
                {mins} minutes
              </option>
            ))}
          </select>
        </div>

        {/* Date window */}
        <div style={styles.formRow}>
          <div style={styles.formGroup}>
            <label htmlFor="window-start" style={styles.label}>
              Window Start
            </label>
            <input
              id="window-start"
              data-testid="window-start"
              type="date"
              value={windowStart}
              onChange={(e) => setWindowStart(e.target.value)}
              style={styles.input}
            />
          </div>
          <div style={styles.formGroup}>
            <label htmlFor="window-end" style={styles.label}>
              Window End
            </label>
            <input
              id="window-end"
              data-testid="window-end"
              type="date"
              value={windowEnd}
              onChange={(e) => setWindowEnd(e.target.value)}
              style={styles.input}
            />
          </div>
        </div>

        {/* Participants */}
        <div style={styles.formGroup}>
          <label style={styles.label}>Participants</label>
          <div style={styles.participantList}>
            {accounts.map((account) => (
              <label
                key={account.account_id}
                data-testid={`participant-${account.account_id}`}
                style={styles.checkboxLabel}
              >
                <input
                  type="checkbox"
                  checked={selectedParticipants.has(account.account_id)}
                  onChange={() => toggleParticipant(account.account_id)}
                  style={styles.checkbox}
                />
                {account.email}
              </label>
            ))}
          </div>
        </div>

        {/* Constraints */}
        <div style={styles.formGroup}>
          <label style={styles.label}>Constraints</label>
          <div style={styles.constraintList}>
            <label
              data-testid="constraint-avoid-early-morning"
              style={styles.checkboxLabel}
            >
              <input
                type="checkbox"
                checked={constraints.avoid_early_morning}
                onChange={() => toggleConstraint("avoid_early_morning")}
                style={styles.checkbox}
              />
              Avoid early morning
            </label>
            <label
              data-testid="constraint-avoid-late-evening"
              style={styles.checkboxLabel}
            >
              <input
                type="checkbox"
                checked={constraints.avoid_late_evening}
                onChange={() => toggleConstraint("avoid_late_evening")}
                style={styles.checkbox}
              />
              Avoid late evening
            </label>
            <label
              data-testid="constraint-prefer-existing-gaps"
              style={styles.checkboxLabel}
            >
              <input
                type="checkbox"
                checked={constraints.prefer_existing_gaps}
                onChange={() => toggleConstraint("prefer_existing_gaps")}
                style={styles.checkbox}
              />
              Prefer existing gaps
            </label>
          </div>
        </div>

        {/* Submit */}
        <button
          data-testid="propose-meeting-btn"
          onClick={handleSubmit}
          disabled={submitting || selectedParticipants.size === 0 || !windowStart || !windowEnd}
          style={{
            ...styles.submitBtn,
            opacity: submitting || selectedParticipants.size === 0 || !windowStart || !windowEnd ? 0.5 : 1,
            cursor: submitting || selectedParticipants.size === 0 || !windowStart || !windowEnd ? "not-allowed" : "pointer",
          }}
        >
          {submitting ? "Creating..." : "Propose Meeting"}
        </button>
      </div>

      {/* Active Sessions */}
      <div style={styles.sessionsSection}>
        <h2 style={styles.sectionTitle}>Sessions</h2>

        {sessions.length === 0 ? (
          <div data-testid="sessions-empty" style={styles.emptyState}>
            No scheduling sessions yet. Create one above.
          </div>
        ) : (
          <div data-testid="sessions-list" style={styles.sessionsList}>
            {sessions.map((session) => (
              <div key={session.session_id}>
                {/* Session row */}
                <div
                  data-testid={`session-row-${session.session_id}`}
                  onClick={() => handleSessionClick(session.session_id)}
                  style={{
                    ...styles.sessionRow,
                    ...(expandedSessionId === session.session_id
                      ? styles.sessionRowExpanded
                      : {}),
                    cursor:
                      session.candidates.length > 0 ? "pointer" : "default",
                  }}
                >
                  <div style={styles.sessionInfo}>
                    <span
                      data-testid={`status-badge-${session.session_id}`}
                      style={{
                        ...styles.statusBadge,
                        color: statusColor(session.status),
                        backgroundColor: statusBgColor(session.status),
                      }}
                    >
                      {statusLabel(session.status)}
                    </span>
                    <span style={styles.sessionDuration}>
                      {session.duration_minutes} min
                    </span>
                    <span style={styles.sessionParticipants}>
                      {session.participants.map((p) => p.email).join(", ")}
                    </span>
                  </div>
                  <div style={styles.sessionActions}>
                    {(session.status === "pending" ||
                      session.status === "candidates_ready") && (
                      <button
                        data-testid={`cancel-btn-${session.session_id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCancel(session.session_id);
                        }}
                        style={styles.cancelBtn}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>

                {/* Expanded: Candidate list */}
                {expandedSessionId === session.session_id &&
                  session.candidates.length > 0 && (
                    <div data-testid="candidate-list" style={styles.candidateList}>
                      {session.candidates
                        .slice()
                        .sort((a, b) => b.score - a.score)
                        .map((candidate, index) => {
                          const isBest = index === 0;
                          return (
                            <div
                              key={candidate.candidate_id}
                              data-testid={`candidate-${candidate.candidate_id}`}
                              data-best={isBest ? "true" : "false"}
                              style={{
                                ...styles.candidateRow,
                                ...(isBest ? styles.candidateRowBest : {}),
                              }}
                            >
                              <div style={styles.candidateInfo}>
                                <div style={styles.candidateTime}>
                                  {formatDateTime(candidate.start)} -{" "}
                                  {formatDateTime(candidate.end)}
                                </div>
                                <div style={styles.candidateScore}>
                                  {formatScore(candidate.score)}
                                </div>
                                <div style={styles.candidateExplanation}>
                                  {candidate.explanation}
                                </div>
                              </div>
                              {session.status === "candidates_ready" && (
                                <button
                                  data-testid={`commit-btn-${candidate.candidate_id}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCommit(
                                      session.session_id,
                                      candidate.candidate_id,
                                    );
                                  }}
                                  style={styles.commitBtn}
                                >
                                  {isBest ? "Commit (Best)" : "Commit"}
                                </button>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles (consistent with Billing.tsx / ErrorRecovery.tsx patterns)
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: "1200px",
    margin: "0 auto",
  },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "1rem",
  },
  title: {
    fontSize: "1.5rem",
    fontWeight: 700,
    color: "#f1f5f9",
    margin: 0,
  },
  backLink: {
    color: "#94a3b8",
    fontSize: "0.875rem",
    textDecoration: "none",
  },
  loading: {
    color: "#94a3b8",
    padding: "2rem",
    textAlign: "center" as const,
  },
  errorBox: {
    color: "#fca5a5",
    padding: "2rem",
    textAlign: "center" as const,
  },
  retryBtn: {
    marginTop: "0.5rem",
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "1px solid #ef4444",
    background: "transparent",
    color: "#ef4444",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  emptyState: {
    color: "#94a3b8",
    padding: "2rem",
    textAlign: "center" as const,
  },
  statusMessage: {
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    fontSize: "0.875rem",
    fontWeight: 500,
    marginBottom: "1rem",
  },
  statusSuccess: {
    backgroundColor: "#064e3b",
    color: "#6ee7b7",
    border: "1px solid #059669",
  },
  statusError: {
    backgroundColor: "#450a0a",
    color: "#fca5a5",
    border: "1px solid #dc2626",
  },

  // -- Form --
  formCard: {
    backgroundColor: "#1e293b",
    borderRadius: "12px",
    padding: "1.5rem",
    border: "1px solid #334155",
    marginBottom: "2rem",
  },
  sectionTitle: {
    fontSize: "1.1rem",
    fontWeight: 700,
    color: "#f1f5f9",
    marginTop: 0,
    marginBottom: "1rem",
  },
  formGroup: {
    marginBottom: "1rem",
  },
  formRow: {
    display: "flex",
    gap: "1rem",
    flexWrap: "wrap" as const,
  },
  label: {
    display: "block",
    fontSize: "0.8rem",
    color: "#94a3b8",
    marginBottom: "0.35rem",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  select: {
    padding: "0.5rem 0.75rem",
    borderRadius: "6px",
    border: "1px solid #475569",
    backgroundColor: "#0f172a",
    color: "#e2e8f0",
    fontSize: "0.875rem",
    width: "100%",
    maxWidth: "200px",
  },
  input: {
    padding: "0.5rem 0.75rem",
    borderRadius: "6px",
    border: "1px solid #475569",
    backgroundColor: "#0f172a",
    color: "#e2e8f0",
    fontSize: "0.875rem",
  },
  participantList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.35rem",
  },
  constraintList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.35rem",
  },
  checkboxLabel: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    fontSize: "0.875rem",
    color: "#cbd5e1",
    cursor: "pointer",
  },
  checkbox: {
    accentColor: "#3b82f6",
  },
  submitBtn: {
    padding: "0.5rem 1.25rem",
    borderRadius: "6px",
    border: "none",
    backgroundColor: "#3b82f6",
    color: "#ffffff",
    fontSize: "0.875rem",
    fontWeight: 600,
  },

  // -- Sessions list --
  sessionsSection: {
    marginBottom: "2rem",
  },
  sessionsList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.5rem",
  },
  sessionRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0.75rem 1rem",
    backgroundColor: "#1e293b",
    borderTopLeftRadius: "8px",
    borderTopRightRadius: "8px",
    borderBottomLeftRadius: "8px",
    borderBottomRightRadius: "8px",
    borderTop: "1px solid #334155",
    borderLeft: "1px solid #334155",
    borderRight: "1px solid #334155",
    borderBottom: "1px solid #334155",
    flexWrap: "wrap" as const,
  },
  sessionRowExpanded: {
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderBottom: "none",
  },
  sessionInfo: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    flexWrap: "wrap" as const,
  },
  statusBadge: {
    padding: "0.2rem 0.5rem",
    borderRadius: "4px",
    fontSize: "0.75rem",
    fontWeight: 600,
  },
  sessionDuration: {
    fontSize: "0.875rem",
    color: "#e2e8f0",
    fontWeight: 500,
  },
  sessionParticipants: {
    fontSize: "0.8rem",
    color: "#94a3b8",
  },
  sessionActions: {
    display: "flex",
    gap: "0.5rem",
  },
  cancelBtn: {
    padding: "0.35rem 0.75rem",
    borderRadius: "6px",
    border: "1px solid #ef4444",
    background: "transparent",
    color: "#ef4444",
    cursor: "pointer",
    fontSize: "0.8rem",
  },

  // -- Candidate list --
  candidateList: {
    backgroundColor: "#1e293b",
    borderRadius: "0 0 8px 8px",
    border: "1px solid #334155",
    borderTop: "none",
    padding: "0.5rem",
  },
  candidateRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "0.75rem",
    borderRadius: "6px",
    marginBottom: "0.25rem",
    backgroundColor: "#0f172a",
    border: "1px solid #1e293b",
    flexWrap: "wrap" as const,
    gap: "0.5rem",
  },
  candidateRowBest: {
    borderColor: "#3b82f6",
    boxShadow: "0 0 0 1px #3b82f6",
  },
  candidateInfo: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.25rem",
    flex: 1,
    minWidth: 0,
  },
  candidateTime: {
    fontSize: "0.875rem",
    color: "#e2e8f0",
    fontWeight: 500,
  },
  candidateScore: {
    fontSize: "1rem",
    fontWeight: 700,
    color: "#3b82f6",
  },
  candidateExplanation: {
    fontSize: "0.8rem",
    color: "#94a3b8",
  },
  commitBtn: {
    padding: "0.35rem 0.75rem",
    borderRadius: "6px",
    border: "none",
    backgroundColor: "#22c55e",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: "0.8rem",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  },
};
