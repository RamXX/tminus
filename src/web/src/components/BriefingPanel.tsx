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
import { motion } from "framer-motion";
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
import { slideInRight, easeOut300, useMotionConfig } from "../lib/motion";

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
    <div
      className="rounded-md border border-border bg-card p-2.5"
      data-testid="participant-card"
    >
      {/* Header: name + category badge */}
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-sm font-semibold text-foreground">
          {displayName}
        </span>
        <span
          className="inline-block rounded-full px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide text-white"
          style={{ backgroundColor: categoryColor }}
        >
          {categoryLabel}
        </span>
      </div>

      {/* Details row */}
      <div className="flex flex-wrap gap-3">
        {/* Last interaction */}
        <div className="flex flex-col gap-px">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Last seen
          </span>
          <span className="font-mono text-xs text-card-foreground">
            {participant.last_interaction_summary ?? "Never"}
          </span>
        </div>

        {/* Reputation score */}
        <div className="flex flex-col gap-px">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Reputation
          </span>
          <span
            className="font-mono text-xs"
            style={{ color: reputation.color }}
          >
            {reputation.display}
          </span>
        </div>

        {/* Drift indicator */}
        <div className="flex flex-col gap-px">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Drift
          </span>
          <span className="font-mono text-xs" style={{ color: drift.color }}>
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
    <div className="flex flex-wrap gap-2 border-t border-border pt-2">
      <button
        className="min-w-[120px] flex-1 cursor-pointer rounded-md border border-primary bg-transparent px-3 py-2 text-[13px] font-semibold text-primary"
        onClick={onGenerateExcuse}
        aria-label="Generate Excuse"
      >
        Generate Excuse
      </button>
      <button
        className="min-w-[120px] flex-1 cursor-pointer rounded-md border border-border bg-transparent px-3 py-2 text-[13px] font-semibold text-muted-foreground"
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
    <div
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/60 p-4"
      data-testid="excuse-modal"
    >
      <div
        className="flex max-h-[90vh] w-full max-w-[480px] flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-background p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="m-0 text-lg font-bold text-foreground">
            Generate Excuse
          </h3>
          <button
            className="cursor-pointer rounded-md border border-border bg-transparent px-2.5 py-1 text-sm font-semibold text-muted-foreground"
            onClick={onClose}
            aria-label="Close"
          >
            X
          </button>
        </div>

        {/* Tone selector */}
        <div className="flex flex-col gap-1.5" data-testid="tone-selector">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Tone
          </span>
          <div className="flex flex-wrap gap-1.5">
            {EXCUSE_TONES.map((t) => (
              <button
                key={t}
                className={`cursor-pointer rounded-md border px-3 py-1.5 text-[13px] font-medium ${
                  tone === t
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-transparent text-muted-foreground"
                }`}
                onClick={() => setTone(t)}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Truth level selector */}
        <div
          className="flex flex-col gap-1.5"
          data-testid="truth-level-selector"
        >
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Truth Level
          </span>
          <div className="flex flex-wrap gap-1.5">
            {TRUTH_LEVELS.map((tl) => (
              <button
                key={tl}
                className={`cursor-pointer rounded-md border px-3 py-1.5 text-[13px] font-medium ${
                  truthLevel === tl
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-transparent text-muted-foreground"
                }`}
                onClick={() => setTruthLevel(tl)}
              >
                {formatTruthLevel(tl)}
              </button>
            ))}
          </div>
        </div>

        {/* Generate button */}
        <button
          className="cursor-pointer rounded-md border-none bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          onClick={handleGenerate}
          disabled={loading}
          aria-label="Generate"
        >
          {loading ? "Generating..." : "Generate"}
        </button>

        {/* Error */}
        {error && (
          <div
            className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
            data-testid="excuse-error"
          >
            {error}
          </div>
        )}

        {/* Draft output */}
        {draft && (
          <div className="flex flex-col gap-2">
            <div
              className="whitespace-pre-wrap rounded-md border border-border bg-card p-3 text-sm leading-relaxed text-foreground"
              data-testid="excuse-draft"
            >
              {draft.draft_message}
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block rounded bg-primary px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-primary-foreground">
                DRAFT
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {draft.tone} / {formatTruthLevel(draft.truth_level)}
              </span>
            </div>
            <button
              className="cursor-pointer self-end rounded-md border border-success bg-transparent px-4 py-1.5 text-[13px] font-semibold text-success"
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
  const { prefersReduced } = useMotionConfig();

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

  // Wrapper: use motion.div when animations are allowed, plain div otherwise
  const PanelWrapper = prefersReduced ? "div" : motion.div;
  const panelMotionProps = prefersReduced
    ? {}
    : {
        variants: slideInRight,
        initial: "hidden",
        animate: "visible",
        transition: easeOut300,
      };

  // Loading state
  if (loading) {
    return (
      <div
        className="w-full border-t border-border py-3"
        data-testid="briefing-loading"
      >
        <div className="mb-2 flex flex-col gap-2">
          <div className="h-6 rounded bg-card" />
          <div className="h-6 rounded bg-card" />
          <div className="h-6 rounded bg-card" />
        </div>
        <p className="m-0 text-center text-[13px] text-muted-foreground">
          Loading briefing...
        </p>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div
        className="w-full border-t border-border py-3"
        data-testid="briefing-error"
      >
        <p className="m-0 text-sm text-destructive">{error}</p>
      </div>
    );
  }

  // Empty state
  if (!briefing) {
    return (
      <div
        className="w-full border-t border-border py-3"
        data-testid="briefing-empty"
      >
        <p className="m-0 mb-3 text-[13px] italic text-muted-foreground">
          No briefing data available.
        </p>
      </div>
    );
  }

  return (
    <PanelWrapper
      className="w-full border-t border-border py-3"
      data-testid="briefing-panel"
      {...panelMotionProps}
    >
      {/* Header */}
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Context Briefing
      </h3>

      {/* Topics */}
      {briefing.topics.length > 0 && (
        <div className="mb-3">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Topics
          </span>
          <div className="flex flex-wrap gap-1.5">
            {briefing.topics.map((topic) => (
              <span
                key={topic}
                className="inline-block rounded-full bg-card px-2 py-0.5 text-xs font-medium text-muted-foreground"
              >
                {topic}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Participants */}
      {briefing.participants.length > 0 ? (
        <div className="mb-3 flex flex-col gap-2">
          {briefing.participants.map((p) => (
            <ParticipantCard key={p.participant_hash} participant={p} />
          ))}
        </div>
      ) : (
        <p className="m-0 mb-3 text-[13px] italic text-muted-foreground">
          No participant data available.
        </p>
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
    </PanelWrapper>
  );
}
