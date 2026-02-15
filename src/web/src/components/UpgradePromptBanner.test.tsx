/**
 * Tests for the UpgradePromptBanner component (TM-d17.4).
 *
 * Covers:
 * - Renders correctly for each prompt trigger type
 * - Displays provider-specific messaging
 * - "Not now" button dismisses the banner
 * - "Upgrade" button navigates to onboarding
 * - Does not render when no prompt should be shown
 * - Non-blocking: renders as a banner, not a modal
 * - Accessibility: keyboard-navigable, proper ARIA
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  UpgradePromptBanner,
  type UpgradePromptBannerProps,
} from "./UpgradePromptBanner";
import type { PromptTriggerResult } from "../lib/upgrade-prompts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFLICT_PROMPT: PromptTriggerResult = {
  type: "conflict_detected",
  message: "T-Minus detected a scheduling conflict between Work Calendar and Personal Calendar. Upgrade to full sync to automatically manage conflicts.",
};

const STALE_PROMPT: PromptTriggerResult = {
  type: "stale_data",
  provider: "google",
  message: "Your Google calendar may be out of date. Connect directly for real-time updates.",
};

const WRITE_INTENT_PROMPT: PromptTriggerResult = {
  type: "write_intent",
  provider: "microsoft",
  message: "ICS feeds are read-only. Connect your Microsoft account to create and edit events.",
};

const ENGAGEMENT_PROMPT: PromptTriggerResult = {
  type: "engagement",
  message: "You're getting value from T-Minus! Upgrade to full sync for real-time updates and two-way editing.",
};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function renderBanner(overrides: Partial<UpgradePromptBannerProps> = {}) {
  const defaultProps: UpgradePromptBannerProps = {
    prompt: CONFLICT_PROMPT,
    onDismiss: vi.fn(),
    onUpgrade: vi.fn(),
    onPermanentDismiss: vi.fn(),
    ...overrides,
  };
  return {
    ...render(<UpgradePromptBanner {...defaultProps} />),
    props: defaultProps,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UpgradePromptBanner", () => {
  describe("rendering", () => {
    it("renders the prompt message text", () => {
      renderBanner({ prompt: CONFLICT_PROMPT });
      expect(screen.getByText(/scheduling conflict/)).toBeInTheDocument();
    });

    it("renders the stale data prompt with provider name", () => {
      renderBanner({ prompt: STALE_PROMPT });
      expect(screen.getByText(/Google calendar may be out of date/)).toBeInTheDocument();
    });

    it("renders the write intent prompt", () => {
      renderBanner({ prompt: WRITE_INTENT_PROMPT });
      expect(screen.getByText(/ICS feeds are read-only/)).toBeInTheDocument();
      expect(screen.getByText(/Microsoft/)).toBeInTheDocument();
    });

    it("renders the engagement prompt", () => {
      renderBanner({ prompt: ENGAGEMENT_PROMPT });
      expect(screen.getByText(/value from T-Minus/)).toBeInTheDocument();
    });

    it("renders 'Not now' dismiss button", () => {
      renderBanner();
      expect(screen.getByRole("button", { name: /not now/i })).toBeInTheDocument();
    });

    it("renders 'Upgrade' button", () => {
      renderBanner();
      expect(screen.getByRole("button", { name: /upgrade/i })).toBeInTheDocument();
    });

    it("renders 'Don't show again' button when onPermanentDismiss is provided", () => {
      renderBanner();
      expect(screen.getByRole("button", { name: /don't show again/i })).toBeInTheDocument();
    });

    it("does not render when prompt is null", () => {
      const { container } = render(
        <UpgradePromptBanner
          prompt={null}
          onDismiss={vi.fn()}
          onUpgrade={vi.fn()}
        />,
      );
      expect(container.firstChild).toBeNull();
    });
  });

  describe("interactions", () => {
    it("calls onDismiss when 'Not now' is clicked", () => {
      const { props } = renderBanner();
      fireEvent.click(screen.getByRole("button", { name: /not now/i }));
      expect(props.onDismiss).toHaveBeenCalledTimes(1);
    });

    it("calls onUpgrade with provider when 'Upgrade' is clicked", () => {
      const { props } = renderBanner({ prompt: STALE_PROMPT });
      fireEvent.click(screen.getByRole("button", { name: /upgrade/i }));
      expect(props.onUpgrade).toHaveBeenCalledTimes(1);
      expect(props.onUpgrade).toHaveBeenCalledWith("google");
    });

    it("calls onUpgrade with undefined when no provider in prompt", () => {
      const { props } = renderBanner({ prompt: ENGAGEMENT_PROMPT });
      fireEvent.click(screen.getByRole("button", { name: /upgrade/i }));
      expect(props.onUpgrade).toHaveBeenCalledWith(undefined);
    });

    it("calls onPermanentDismiss when 'Don't show again' is clicked", () => {
      const { props } = renderBanner();
      fireEvent.click(screen.getByRole("button", { name: /don't show again/i }));
      expect(props.onPermanentDismiss).toHaveBeenCalledTimes(1);
    });

    it("does not render 'Don't show again' when onPermanentDismiss is not provided", () => {
      renderBanner({ onPermanentDismiss: undefined });
      expect(screen.queryByRole("button", { name: /don't show again/i })).not.toBeInTheDocument();
    });
  });

  describe("non-blocking UI", () => {
    it("renders as a banner (role=status), not a dialog/modal", () => {
      renderBanner();
      const banner = screen.getByRole("status");
      expect(banner).toBeInTheDocument();
      // Should not be a dialog
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("has aria-live=polite for non-intrusive announcement", () => {
      renderBanner();
      const banner = screen.getByRole("status");
      expect(banner.getAttribute("aria-live")).toBe("polite");
    });
  });

  describe("accessibility", () => {
    it("dismiss button is keyboard-accessible (tab index)", () => {
      renderBanner();
      const btn = screen.getByRole("button", { name: /not now/i });
      expect(btn).not.toHaveAttribute("tabindex", "-1");
    });

    it("upgrade button is keyboard-accessible", () => {
      renderBanner();
      const btn = screen.getByRole("button", { name: /upgrade/i });
      expect(btn).not.toHaveAttribute("tabindex", "-1");
    });
  });
});
