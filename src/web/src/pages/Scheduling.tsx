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
 * Uses useApi() for token-injected API calls (migrated from prop-passing).
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useApi } from "../lib/api-provider";
import type { LinkedAccount } from "../lib/api";
import type {
  SchedulingSession,
  CreateSessionPayload,
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
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Scheduling() {
  const api = useApi();

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
      const result = await api.listSessions();
      if (!mountedRef.current) return;
      setSessions(result);
      setError(null);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  }, [api]);

  const loadAccounts = useCallback(async () => {
    try {
      const result = await api.fetchAccounts();
      if (!mountedRef.current) return;
      setAccounts(result);
    } catch {
      // Non-critical -- participant selector will be empty
    }
  }, [api]);

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
      await api.createSchedulingSession(payload);

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
    api,
    loadSessions,
    showStatus,
  ]);

  // -------------------------------------------------------------------------
  // Session action handlers
  // -------------------------------------------------------------------------

  const handleCommit = useCallback(
    async (sessionId: string, candidateId: string) => {
      try {
        await api.commitCandidate(sessionId, candidateId);

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
    [api, loadSessions, showStatus],
  );

  const handleCancel = useCallback(
    async (sessionId: string) => {
      try {
        await api.cancelSession(sessionId);

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
    [api, loadSessions, showStatus],
  );

  const handleSessionClick = useCallback((sessionId: string) => {
    setExpandedSessionId((prev) => (prev === sessionId ? null : sessionId));
  }, []);

  // -------------------------------------------------------------------------
  // Render: Loading
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div data-testid="scheduling-loading" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground">Scheduling</h1>
        <p className="text-muted-foreground text-center py-8">Loading scheduling sessions...</p>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Error
  // -------------------------------------------------------------------------

  if (error) {
    return (
      <div data-testid="scheduling-error" className="mx-auto max-w-[1200px]">
        <h1 className="text-2xl font-bold text-foreground">Scheduling</h1>
        <div className="text-destructive text-center py-8">
          <p>Failed to load sessions: {error}</p>
          <Button
            onClick={loadSessions}
            variant="outline"
            className="mt-2 border-destructive text-destructive hover:bg-destructive/10"
            aria-label="Retry"
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render: Main
  // -------------------------------------------------------------------------

  const expandedSession = sessions.find((s) => s.session_id === expandedSessionId) ?? null;

  return (
    <div className="mx-auto max-w-[1200px]">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-foreground">Scheduling</h1>
        <a href="#/calendar" className="text-muted-foreground text-sm no-underline hover:text-foreground">
          Back to Calendar
        </a>
      </div>

      {/* Status message */}
      {statusMsg && (
        <div
          data-testid="scheduling-status-msg"
          className={`px-4 py-2 rounded-md text-sm font-medium mb-4 border ${
            statusMsg.type === "success"
              ? "bg-emerald-950 text-emerald-300 border-emerald-600"
              : "bg-red-950 text-red-300 border-red-700"
          }`}
        >
          {statusMsg.text}
        </div>
      )}

      {/* Propose Meeting Form */}
      <Card data-testid="propose-form" className="mb-6">
        <CardContent className="p-6">
          <h2 className="text-lg font-bold text-foreground mb-4 mt-0">Propose Meeting</h2>

          {/* Duration */}
          <div className="mb-4">
            <label htmlFor="duration-select" className="block text-xs text-muted-foreground uppercase tracking-wider mb-1">
              Duration
            </label>
            <select
              id="duration-select"
              data-testid="duration-select"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm w-full max-w-[200px]"
            >
              {DURATION_OPTIONS.map((mins) => (
                <option key={mins} value={mins}>
                  {mins} minutes
                </option>
              ))}
            </select>
          </div>

          {/* Date window */}
          <div className="flex gap-4 flex-wrap">
            <div className="mb-4">
              <label htmlFor="window-start" className="block text-xs text-muted-foreground uppercase tracking-wider mb-1">
                Window Start
              </label>
              <input
                id="window-start"
                data-testid="window-start"
                type="date"
                value={windowStart}
                onChange={(e) => setWindowStart(e.target.value)}
                className="px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm"
              />
            </div>
            <div className="mb-4">
              <label htmlFor="window-end" className="block text-xs text-muted-foreground uppercase tracking-wider mb-1">
                Window End
              </label>
              <input
                id="window-end"
                data-testid="window-end"
                type="date"
                value={windowEnd}
                onChange={(e) => setWindowEnd(e.target.value)}
                className="px-3 py-2 rounded-md border border-input bg-background text-foreground text-sm"
              />
            </div>
          </div>

          {/* Participants */}
          <div className="mb-4">
            <label className="block text-xs text-muted-foreground uppercase tracking-wider mb-1">Participants</label>
            <div className="flex flex-col gap-1">
              {accounts.map((account) => (
                <label
                  key={account.account_id}
                  data-testid={`participant-${account.account_id}`}
                  className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedParticipants.has(account.account_id)}
                    onChange={() => toggleParticipant(account.account_id)}
                    className="accent-primary"
                  />
                  {account.email}
                </label>
              ))}
            </div>
          </div>

          {/* Constraints */}
          <div className="mb-4">
            <label className="block text-xs text-muted-foreground uppercase tracking-wider mb-1">Constraints</label>
            <div className="flex flex-col gap-1">
              <label
                data-testid="constraint-avoid-early-morning"
                className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={constraints.avoid_early_morning}
                  onChange={() => toggleConstraint("avoid_early_morning")}
                  className="accent-primary"
                />
                Avoid early morning
              </label>
              <label
                data-testid="constraint-avoid-late-evening"
                className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={constraints.avoid_late_evening}
                  onChange={() => toggleConstraint("avoid_late_evening")}
                  className="accent-primary"
                />
                Avoid late evening
              </label>
              <label
                data-testid="constraint-prefer-existing-gaps"
                className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={constraints.prefer_existing_gaps}
                  onChange={() => toggleConstraint("prefer_existing_gaps")}
                  className="accent-primary"
                />
                Prefer existing gaps
              </label>
            </div>
          </div>

          {/* Submit */}
          <Button
            data-testid="propose-meeting-btn"
            onClick={handleSubmit}
            disabled={submitting || selectedParticipants.size === 0 || !windowStart || !windowEnd}
          >
            {submitting ? "Creating..." : "Propose Meeting"}
          </Button>
        </CardContent>
      </Card>

      {/* Active Sessions */}
      <div className="mb-6">
        <h2 className="text-lg font-bold text-foreground mb-4">Sessions</h2>

        {sessions.length === 0 ? (
          <div data-testid="sessions-empty" className="text-muted-foreground text-center py-8">
            No scheduling sessions yet. Create one above.
          </div>
        ) : (
          <div data-testid="sessions-list" className="flex flex-col gap-2">
            {sessions.map((session) => (
              <div key={session.session_id}>
                {/* Session row */}
                <div
                  data-testid={`session-row-${session.session_id}`}
                  onClick={() => handleSessionClick(session.session_id)}
                  className={`flex justify-between items-center px-4 py-3 bg-card border border-border flex-wrap rounded-lg ${
                    expandedSessionId === session.session_id
                      ? "rounded-b-none border-b-0"
                      : ""
                  } ${session.candidates.length > 0 ? "cursor-pointer" : "cursor-default"}`}
                >
                  <div className="flex items-center gap-3 flex-wrap">
                    <span
                      data-testid={`status-badge-${session.session_id}`}
                      className="px-2 py-0.5 rounded text-xs font-semibold"
                      style={{
                        color: statusColor(session.status),
                        backgroundColor: statusBgColor(session.status),
                      }}
                    >
                      {statusLabel(session.status)}
                    </span>
                    <span className="text-sm text-foreground font-medium">
                      {session.duration_minutes} min
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {session.participants.map((p) => p.email).join(", ")}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    {(session.status === "pending" ||
                      session.status === "candidates_ready") && (
                      <Button
                        data-testid={`cancel-btn-${session.session_id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCancel(session.session_id);
                        }}
                        variant="outline"
                        size="sm"
                        className="border-destructive text-destructive hover:bg-destructive/10"
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </div>

                {/* Expanded: Candidate list */}
                {expandedSessionId === session.session_id &&
                  session.candidates.length > 0 && (
                    <div data-testid="candidate-list" className="bg-card rounded-b-lg border border-border border-t-0 p-2">
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
                              className={`flex justify-between items-center p-3 rounded-md mb-1 bg-background border flex-wrap gap-2 ${
                                isBest ? "border-primary ring-1 ring-primary" : "border-border"
                              }`}
                            >
                              <div className="flex flex-col gap-1 flex-1 min-w-0">
                                <div className="text-sm text-foreground font-medium">
                                  {formatDateTime(candidate.start)} -{" "}
                                  {formatDateTime(candidate.end)}
                                </div>
                                <div className="text-base font-bold text-primary">
                                  {formatScore(candidate.score)}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {candidate.explanation}
                                </div>
                              </div>
                              {session.status === "candidates_ready" && (
                                <Button
                                  data-testid={`commit-btn-${candidate.candidate_id}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCommit(
                                      session.session_id,
                                      candidate.candidate_id,
                                    );
                                  }}
                                  size="sm"
                                  className="bg-green-600 hover:bg-green-700 text-white whitespace-nowrap"
                                >
                                  {isBest ? "Commit (Best)" : "Commit"}
                                </Button>
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
