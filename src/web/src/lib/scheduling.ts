/**
 * Scheduling types and helpers.
 *
 * Defines the data shapes for scheduling sessions, candidates,
 * and related API request/response types. Used by the Scheduling
 * page and its tests.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status of a scheduling session. */
export type SessionStatus =
  | "pending"
  | "candidates_ready"
  | "committed"
  | "cancelled"
  | "failed";

/** A participant in a scheduling session. */
export interface SessionParticipant {
  account_id: string;
  email: string;
}

/** A candidate time slot with a score and explanation. */
export interface SchedulingCandidate {
  candidate_id: string;
  start: string;
  end: string;
  score: number;
  explanation: string;
}

/** Constraint toggles for session creation. */
export interface SchedulingConstraints {
  avoid_early_morning: boolean;
  avoid_late_evening: boolean;
  prefer_existing_gaps: boolean;
}

/** A scheduling session as returned by the API. */
export interface SchedulingSession {
  session_id: string;
  status: SessionStatus;
  duration_minutes: number;
  window_start: string;
  window_end: string;
  participants: SessionParticipant[];
  constraints: SchedulingConstraints;
  candidates: SchedulingCandidate[];
  created_at: string;
  updated_at: string;
}

/** Payload for creating a new scheduling session. */
export interface CreateSessionPayload {
  duration_minutes: number;
  window_start: string;
  window_end: string;
  participant_account_ids: string[];
  constraints: SchedulingConstraints;
}

/** Response from committing a candidate. */
export interface CommitResponse {
  session_id: string;
  event_id: string;
  status: "committed";
}

/** Response from cancelling a session. */
export interface CancelResponse {
  session_id: string;
  status: "cancelled";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Human-readable label for a session status. */
export function statusLabel(status: SessionStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "candidates_ready":
      return "Ready";
    case "committed":
      return "Committed";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
  }
}

/** CSS color for a session status badge. */
export function statusColor(status: SessionStatus): string {
  switch (status) {
    case "pending":
      return "#f59e0b";
    case "candidates_ready":
      return "#3b82f6";
    case "committed":
      return "#22c55e";
    case "cancelled":
      return "#94a3b8";
    case "failed":
      return "#ef4444";
  }
}

/** Background color for a session status badge. */
export function statusBgColor(status: SessionStatus): string {
  switch (status) {
    case "pending":
      return "#451a03";
    case "candidates_ready":
      return "#1e3a5f";
    case "committed":
      return "#052e16";
    case "cancelled":
      return "#1e293b";
    case "failed":
      return "#450a0a";
  }
}

/** Format a score as a percentage string. */
export function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/** Format an ISO datetime for display (date + time). */
export function formatDateTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Default constraints for new sessions. */
export function defaultConstraints(): SchedulingConstraints {
  return {
    avoid_early_morning: false,
    avoid_late_evening: false,
    prefer_existing_gaps: true,
  };
}

/** Available duration options in minutes. */
export const DURATION_OPTIONS = [15, 30, 45, 60, 90, 120];
