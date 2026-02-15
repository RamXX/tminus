/**
 * UpgradePromptBanner -- non-blocking contextual upgrade nudge (TM-d17.4).
 *
 * Renders a dismissable banner at the top of the calendar view suggesting
 * the user upgrade from ICS-only to full OAuth sync. The banner:
 * - Is NOT a modal (BR-1: informational, not blocking)
 * - Shows provider-specific messaging and branding
 * - Has "Not now" dismiss and "Upgrade" CTA buttons
 * - Uses role="status" with aria-live="polite" for accessibility
 *
 * The parent component (Calendar) controls when this renders by passing
 * a prompt (or null) based on UpgradePromptManager evaluation.
 */

import type { PromptTriggerResult } from "../lib/upgrade-prompts";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface UpgradePromptBannerProps {
  /** The prompt to display, or null to hide the banner. */
  prompt: PromptTriggerResult | null;
  /** Called when the user clicks "Not now". */
  onDismiss: () => void;
  /** Called when the user clicks "Upgrade", with the provider (if available). */
  onUpgrade: (provider?: string) => void;
  /** Called when the user clicks "Don't show again" to permanently disable prompts. */
  onPermanentDismiss?: () => void;
}

// ---------------------------------------------------------------------------
// Provider branding
// ---------------------------------------------------------------------------

const PROVIDER_COLORS: Record<string, string> = {
  google: "#4285F4",
  microsoft: "#7B2AE0",
  apple: "#555555",
};

const TRIGGER_COLORS: Record<string, string> = {
  conflict_detected: "#f59e0b", // amber -- attention
  stale_data: "#3b82f6",       // blue -- informational
  write_intent: "#8b5cf6",     // purple -- action
  engagement: "#22c55e",       // green -- positive
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UpgradePromptBanner({
  prompt,
  onDismiss,
  onUpgrade,
  onPermanentDismiss,
}: UpgradePromptBannerProps) {
  if (!prompt) return null;

  const accentColor =
    (prompt.provider && PROVIDER_COLORS[prompt.provider]) ||
    TRIGGER_COLORS[prompt.type] ||
    "#3b82f6";

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        ...bannerStyles.container,
        borderLeft: `4px solid ${accentColor}`,
      }}
    >
      <div style={bannerStyles.content}>
        <p style={bannerStyles.message}>{prompt.message}</p>
        <div style={bannerStyles.actions}>
          {onPermanentDismiss && (
            <button
              onClick={onPermanentDismiss}
              style={bannerStyles.permanentDismissBtn}
              aria-label="Don't show again"
            >
              Don't show again
            </button>
          )}
          <button
            onClick={onDismiss}
            style={bannerStyles.dismissBtn}
            aria-label="Not now"
          >
            Not now
          </button>
          <button
            onClick={() => onUpgrade(prompt.provider)}
            style={{
              ...bannerStyles.upgradeBtn,
              backgroundColor: accentColor,
            }}
            aria-label="Upgrade"
          >
            Upgrade
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const bannerStyles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    alignItems: "center",
    padding: "0.75rem 1rem",
    marginBottom: "0.75rem",
    borderRadius: "6px",
    background: "#1e293b",
    border: "1px solid #334155",
  },
  content: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    width: "100%",
    gap: "1rem",
  },
  message: {
    margin: 0,
    fontSize: "0.875rem",
    color: "#e2e8f0",
    lineHeight: 1.4,
    flex: 1,
  },
  actions: {
    display: "flex",
    gap: "0.5rem",
    flexShrink: 0,
  },
  permanentDismissBtn: {
    padding: "0.375rem 0.75rem",
    borderRadius: "4px",
    border: "none",
    background: "transparent",
    color: "#64748b",
    cursor: "pointer",
    fontSize: "0.75rem",
    whiteSpace: "nowrap" as const,
    textDecoration: "underline",
  },
  dismissBtn: {
    padding: "0.375rem 0.75rem",
    borderRadius: "4px",
    border: "1px solid #475569",
    background: "transparent",
    color: "#94a3b8",
    cursor: "pointer",
    fontSize: "0.8125rem",
    whiteSpace: "nowrap" as const,
  },
  upgradeBtn: {
    padding: "0.375rem 0.75rem",
    borderRadius: "4px",
    border: "none",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: "0.8125rem",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  },
};
