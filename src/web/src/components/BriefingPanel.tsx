/**
 * BriefingPanel -- pre-meeting context briefing UI.
 *
 * Shows participant context cards within event detail view.
 * Fetches briefing data from /v1/events/:id/briefing when mounted.
 *
 * Sub-components:
 *   ParticipantCard -- name, category badge, last interaction, reputation, drift
 *   ActionButtons   -- Generate Excuse + Propose Reschedule buttons
 *   ExcuseModal     -- tone selector, truth level selector, draft, copy button
 *
 * Props:
 *   eventId          -- canonical event ID to fetch briefing for
 *   fetchBriefing    -- injected API function (testable without mocking globals)
 *   generateExcuse   -- injected API function for excuse generation
 */

import { useState, useEffect, useCallback } from "react";
import type {
  EventBriefing,
  BriefingParticipant,
  ExcuseOutput,
  ExcuseTone,
  TruthLevel,
} from "../lib/briefing";
import {
  getCategoryColor,
  formatCategory,
  formatReputationScore,
  computeDriftIndicator,
  formatTruthLevel,
  EXCUSE_TONES,
  TRUTH_LEVELS,
} from "../lib/briefing";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BriefingPanelProps {
  eventId: string;
  fetchBriefing: (eventId: string) => Promise<EventBriefing>;
  generateExcuse: (
    eventId: string,
    params: { tone: ExcuseTone; truth_level: TruthLevel },
  ) => Promise<ExcuseOutput>;
}

// ---------------------------------------------------------------------------
// ParticipantCard
// ---------------------------------------------------------------------------

interface ParticipantCardProps {
  participant: BriefingParticipant;
}

function ParticipantCard({ participant }: ParticipantCardProps) {
  const categoryColor = getCategoryColor(participant.category);
  const categoryLabel = formatCategory(participant.category);
  const reputation = formatReputationScore(participant.reputation_score);
  const drift = computeDriftIndicator(participant.last_interaction_ts);
  const displayName = participant.display_name ?? "Unknown";

  return (
    <div style={styles.participantCard} data-testid="participant-card">
      {/* Header: name + category badge */}
      <div style={styles.participantHeader}>
        <span style={styles.participantName}>{displayName}</span>
        <span
          style={{
            ...styles.categoryBadge,
            backgroundColor: categoryColor,
          }}
        >
          {categoryLabel}
        </span>
      </div>

      {/* Details row */}
      <div style={styles.participantDetails}>
        {/* Last interaction */}
        <div style={styles.detailItem}>
          <span style={styles.detailLabel}>Last seen</span>
          <span style={styles.detailValue}>
            {participant.last_interaction_summary ?? "Never"}
          </span>
        </div>

        {/* Reputation score */}
        <div style={styles.detailItem}>
          <span style={styles.detailLabel}>Reputation</span>
          <span style={{ ...styles.detailValue, color: reputation.color }}>
            {reputation.display}
          </span>
        </div>

        {/* Drift indicator */}
        <div style={styles.detailItem}>
          <span style={styles.detailLabel}>Drift</span>
          <span style={{ ...styles.detailValue, color: drift.color }}>
            {drift.label}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActionButtons
// ---------------------------------------------------------------------------

interface ActionButtonsProps {
  onGenerateExcuse: () => void;
  onProposeReschedule: () => void;
}

function ActionButtons({
  onGenerateExcuse,
  onProposeReschedule,
}: ActionButtonsProps) {
  return (
    <div style={styles.actionButtons}>
      <button
        style={styles.excuseBtn}
        onClick={onGenerateExcuse}
        aria-label="Generate Excuse"
      >
        Generate Excuse
      </button>
      <button
        style={styles.rescheduleBtn}
        onClick={onProposeReschedule}
        aria-label="Propose Reschedule"
      >
        Propose Reschedule
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExcuseModal
// ---------------------------------------------------------------------------

interface ExcuseModalProps {
  eventId: string;
  generateExcuse: (
    eventId: string,
    params: { tone: ExcuseTone; truth_level: TruthLevel },
  ) => Promise<ExcuseOutput>;
  onClose: () => void;
}

function ExcuseModal({ eventId, generateExcuse, onClose }: ExcuseModalProps) {
  const [tone, setTone] = useState<ExcuseTone>("formal");
  const [truthLevel, setTruthLevel] = useState<TruthLevel>("full");
  const [draft, setDraft] = useState<ExcuseOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleGenerate = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const result = await generateExcuse(eventId, {
        tone,
        truth_level: truthLevel,
      });
      setDraft(result);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to generate excuse",
      );
    } finally {
      setLoading(false);
    }
  }, [eventId, generateExcuse, tone, truthLevel]);

  const handleCopy = useCallback(async () => {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft.draft_message);
      setCopied(true);
      // Reset "Copied" feedback after 2 seconds
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be unavailable
    }
  }, [draft]);

  return (
    <div style={styles.modalOverlay} data-testid="excuse-modal">
      <div
        style={styles.modalContent}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={styles.modalHeader}>
          <h3 style={styles.modalTitle}>Generate Excuse</h3>
          <button
            style={styles.modalCloseBtn}
            onClick={onClose}
            aria-label="Close"
          >
            X
          </button>
        </div>

        {/* Tone selector */}
        <div style={styles.selectorGroup} data-testid="tone-selector">
          <span style={styles.selectorLabel}>Tone</span>
          <div style={styles.selectorOptions}>
            {EXCUSE_TONES.map((t) => (
              <button
                key={t}
                style={
                  tone === t
                    ? { ...styles.selectorBtn, ...styles.selectorBtnActive }
                    : styles.selectorBtn
                }
                onClick={() => setTone(t)}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Truth level selector */}
        <div style={styles.selectorGroup} data-testid="truth-level-selector">
          <span style={styles.selectorLabel}>Truth Level</span>
          <div style={styles.selectorOptions}>
            {TRUTH_LEVELS.map((tl) => (
              <button
                key={tl}
                style={
                  truthLevel === tl
                    ? { ...styles.selectorBtn, ...styles.selectorBtnActive }
                    : styles.selectorBtn
                }
                onClick={() => setTruthLevel(tl)}
              >
                {formatTruthLevel(tl)}
              </button>
            ))}
          </div>
        </div>

        {/* Generate button */}
        <button
          style={styles.generateBtn}
          onClick={handleGenerate}
          disabled={loading}
          aria-label="Generate"
        >
          {loading ? "Generating..." : "Generate"}
        </button>

        {/* Error */}
        {error && (
          <div style={styles.excuseError} data-testid="excuse-error">
            {error}
          </div>
        )}

        {/* Draft output */}
        {draft && (
          <div style={styles.draftSection}>
            <div style={styles.draftContent} data-testid="excuse-draft">
              {draft.draft_message}
            </div>
            <div style={styles.draftMeta}>
              <span style={styles.draftBadge}>DRAFT</span>
              <span style={styles.draftTone}>
                {draft.tone} / {formatTruthLevel(draft.truth_level)}
              </span>
            </div>
            <button
              style={styles.copyBtn}
              onClick={handleCopy}
              aria-label="Copy"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BriefingPanel (main export)
// ---------------------------------------------------------------------------

export function BriefingPanel({
  eventId,
  fetchBriefing,
  generateExcuse,
}: BriefingPanelProps) {
  const [briefing, setBriefing] = useState<EventBriefing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showExcuseModal, setShowExcuseModal] = useState(false);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError(null);

    fetchBriefing(eventId)
      .then((data) => {
        if (!cancelled) {
          setBriefing(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load briefing",
          );
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [eventId, fetchBriefing]);

  const handleOpenExcuse = useCallback(() => {
    setShowExcuseModal(true);
  }, []);

  const handleCloseExcuse = useCallback(() => {
    setShowExcuseModal(false);
  }, []);

  const handleProposeReschedule = useCallback(() => {
    // Future: open reschedule flow. For now, opens the scheduling page.
    window.location.hash = "#/scheduling";
  }, []);

  // Loading state
  if (loading) {
    return (
      <div style={styles.panel} data-testid="briefing-loading">
        <div style={styles.loadingSkeleton}>
          <div style={styles.skeletonRow} />
          <div style={styles.skeletonRow} />
          <div style={styles.skeletonRow} />
        </div>
        <p style={styles.loadingText}>Loading briefing...</p>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div style={styles.panel} data-testid="briefing-error">
        <p style={styles.errorText}>{error}</p>
      </div>
    );
  }

  // Empty state
  if (!briefing) {
    return (
      <div style={styles.panel} data-testid="briefing-empty">
        <p style={styles.emptyText}>No briefing data available.</p>
      </div>
    );
  }

  return (
    <div style={styles.panel} data-testid="briefing-panel">
      {/* Header */}
      <h3 style={styles.panelTitle}>Context Briefing</h3>

      {/* Topics */}
      {briefing.topics.length > 0 && (
        <div style={styles.topicsSection}>
          <span style={styles.topicsLabel}>Topics</span>
          <div style={styles.topicsList}>
            {briefing.topics.map((topic) => (
              <span key={topic} style={styles.topicBadge}>
                {topic}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Participants */}
      {briefing.participants.length > 0 ? (
        <div style={styles.participantsList}>
          {briefing.participants.map((p) => (
            <ParticipantCard key={p.participant_hash} participant={p} />
          ))}
        </div>
      ) : (
        <p style={styles.emptyText}>No participant data available.</p>
      )}

      {/* Actions */}
      <ActionButtons
        onGenerateExcuse={handleOpenExcuse}
        onProposeReschedule={handleProposeReschedule}
      />

      {/* Excuse Modal */}
      {showExcuseModal && (
        <ExcuseModal
          eventId={eventId}
          generateExcuse={generateExcuse}
          onClose={handleCloseExcuse}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  // Panel
  panel: {
    width: "100%",
    padding: "0.75rem 0",
    borderTop: "1px solid #1e293b",
  },
  panelTitle: {
    margin: "0 0 0.75rem 0",
    fontSize: "0.9375rem",
    fontWeight: 700,
    color: "#e2e8f0",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },

  // Topics
  topicsSection: {
    marginBottom: "0.75rem",
  },
  topicsLabel: {
    display: "block",
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "#64748b",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    marginBottom: "0.375rem",
  },
  topicsList: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.375rem",
  },
  topicBadge: {
    display: "inline-block",
    padding: "0.125rem 0.5rem",
    borderRadius: "9999px",
    backgroundColor: "#1e293b",
    color: "#94a3b8",
    fontSize: "0.75rem",
    fontWeight: 500,
  },

  // Participants list
  participantsList: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    marginBottom: "0.75rem",
  },

  // Participant card
  participantCard: {
    padding: "0.625rem",
    backgroundColor: "#1e293b",
    borderRadius: "6px",
    border: "1px solid #334155",
  },
  participantHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "0.375rem",
  },
  participantName: {
    fontSize: "0.875rem",
    fontWeight: 600,
    color: "#e2e8f0",
  },
  categoryBadge: {
    display: "inline-block",
    padding: "0.0625rem 0.375rem",
    borderRadius: "9999px",
    color: "#ffffff",
    fontSize: "0.6875rem",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.03em",
  },
  participantDetails: {
    display: "flex",
    gap: "0.75rem",
    flexWrap: "wrap",
  },
  detailItem: {
    display: "flex",
    flexDirection: "column",
    gap: "0.0625rem",
  },
  detailLabel: {
    fontSize: "0.625rem",
    fontWeight: 600,
    color: "#64748b",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  detailValue: {
    fontSize: "0.8125rem",
    fontWeight: 500,
    color: "#cbd5e1",
  },

  // Action buttons
  actionButtons: {
    display: "flex",
    gap: "0.5rem",
    flexWrap: "wrap",
    paddingTop: "0.5rem",
    borderTop: "1px solid #1e293b",
  },
  excuseBtn: {
    flex: 1,
    padding: "0.5rem 0.75rem",
    borderRadius: "6px",
    border: "1px solid #f59e0b",
    background: "transparent",
    color: "#f59e0b",
    cursor: "pointer",
    fontSize: "0.8125rem",
    fontWeight: 600,
    minWidth: "120px",
  },
  rescheduleBtn: {
    flex: 1,
    padding: "0.5rem 0.75rem",
    borderRadius: "6px",
    border: "1px solid #3b82f6",
    background: "transparent",
    color: "#3b82f6",
    cursor: "pointer",
    fontSize: "0.8125rem",
    fontWeight: 600,
    minWidth: "120px",
  },

  // Loading
  loadingSkeleton: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
    marginBottom: "0.5rem",
  },
  skeletonRow: {
    height: "1.5rem",
    borderRadius: "4px",
    background: "#1e293b",
  },
  loadingText: {
    color: "#64748b",
    fontSize: "0.8125rem",
    textAlign: "center",
    margin: 0,
  },

  // Error
  errorText: {
    color: "#fca5a5",
    fontSize: "0.875rem",
    margin: 0,
  },

  // Empty
  emptyText: {
    color: "#64748b",
    fontSize: "0.8125rem",
    fontStyle: "italic",
    margin: "0 0 0.75rem 0",
  },

  // Modal overlay
  modalOverlay: {
    position: "fixed",
    inset: 0,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1100,
    padding: "1rem",
  },
  modalContent: {
    width: "100%",
    maxWidth: "480px",
    backgroundColor: "#0f172a",
    borderRadius: "12px",
    border: "1px solid #334155",
    padding: "1.5rem",
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
    maxHeight: "90vh",
    overflowY: "auto",
  },
  modalHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  modalTitle: {
    margin: 0,
    fontSize: "1.125rem",
    fontWeight: 700,
    color: "#f1f5f9",
  },
  modalCloseBtn: {
    background: "transparent",
    border: "1px solid #334155",
    borderRadius: "6px",
    color: "#94a3b8",
    fontSize: "0.875rem",
    fontWeight: 600,
    padding: "0.25rem 0.625rem",
    cursor: "pointer",
  },

  // Selector groups
  selectorGroup: {
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
  },
  selectorLabel: {
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "#94a3b8",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  selectorOptions: {
    display: "flex",
    gap: "0.375rem",
    flexWrap: "wrap",
  },
  selectorBtn: {
    padding: "0.375rem 0.75rem",
    borderRadius: "6px",
    border: "1px solid #334155",
    background: "transparent",
    color: "#94a3b8",
    cursor: "pointer",
    fontSize: "0.8125rem",
    fontWeight: 500,
  },
  selectorBtnActive: {
    background: "#1e40af",
    color: "#ffffff",
    border: "1px solid #1e40af",
  },

  // Generate button
  generateBtn: {
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    border: "none",
    background: "#3b82f6",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 600,
  },

  // Error in excuse modal
  excuseError: {
    padding: "0.75rem",
    borderRadius: "6px",
    backgroundColor: "#2d1b1b",
    border: "1px solid #7f1d1d",
    color: "#fca5a5",
    fontSize: "0.875rem",
  },

  // Draft section
  draftSection: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  draftContent: {
    padding: "0.75rem",
    backgroundColor: "#1e293b",
    borderRadius: "6px",
    border: "1px solid #334155",
    color: "#e2e8f0",
    fontSize: "0.875rem",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap" as const,
  },
  draftMeta: {
    display: "flex",
    gap: "0.5rem",
    alignItems: "center",
  },
  draftBadge: {
    display: "inline-block",
    padding: "0.0625rem 0.375rem",
    borderRadius: "4px",
    backgroundColor: "#f59e0b",
    color: "#000000",
    fontSize: "0.625rem",
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  draftTone: {
    fontSize: "0.75rem",
    color: "#64748b",
  },
  copyBtn: {
    alignSelf: "flex-end",
    padding: "0.375rem 1rem",
    borderRadius: "6px",
    border: "1px solid #22c55e",
    background: "transparent",
    color: "#22c55e",
    cursor: "pointer",
    fontSize: "0.8125rem",
    fontWeight: 600,
  },
};
