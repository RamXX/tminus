/**
 * Unit tests for EventCreateForm component.
 *
 * Tests cover:
 * - Renders all form fields
 * - Pre-fills start/end from initialDate
 * - Validates required title
 * - Validates end after start
 * - Calls onSubmit with correct payload
 * - Calls onCancel when close/cancel clicked
 * - Disables form when submitting
 * - Shows error message when provided
 * - Clears field errors on input change
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EventCreateForm } from "./EventCreateForm";
import type { CreateEventPayload } from "../lib/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_DATE = new Date("2026-02-14T09:00:00");

function renderForm(overrides: Partial<React.ComponentProps<typeof EventCreateForm>> = {}) {
  const defaultProps: React.ComponentProps<typeof EventCreateForm> = {
    initialDate: DEFAULT_DATE,
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  return {
    ...render(<EventCreateForm {...defaultProps} />),
    props: defaultProps,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EventCreateForm", () => {
  const user = userEvent.setup();

  describe("rendering", () => {
    it("renders all form fields", () => {
      renderForm();
      expect(screen.getByTestId("event-title-input")).toBeInTheDocument();
      expect(screen.getByTestId("event-start-date-input")).toBeInTheDocument();
      expect(screen.getByTestId("event-start-time-input")).toBeInTheDocument();
      expect(screen.getByTestId("event-end-date-input")).toBeInTheDocument();
      expect(screen.getByTestId("event-end-time-input")).toBeInTheDocument();
      expect(screen.getByTestId("event-timezone-input")).toBeInTheDocument();
      expect(screen.getByTestId("event-description-input")).toBeInTheDocument();
      expect(screen.getByTestId("event-location-input")).toBeInTheDocument();
    });

    it("renders the New Event title", () => {
      renderForm();
      expect(screen.getByText("New Event")).toBeInTheDocument();
    });

    it("renders submit button", () => {
      renderForm();
      expect(screen.getByTestId("event-create-submit")).toBeInTheDocument();
      expect(screen.getByTestId("event-create-submit")).toHaveTextContent("Create Event");
    });

    it("pre-fills start date from initialDate", () => {
      renderForm();
      const startDate = screen.getByTestId("event-start-date-input") as HTMLInputElement;
      expect(startDate.value).toBe("2026-02-14");
    });

    it("pre-fills start time from initialDate", () => {
      renderForm();
      const startTime = screen.getByTestId("event-start-time-input") as HTMLInputElement;
      expect(startTime.value).toBe("09:00");
    });

    it("pre-fills end time 1 hour after start", () => {
      renderForm();
      const endTime = screen.getByTestId("event-end-time-input") as HTMLInputElement;
      expect(endTime.value).toBe("10:00");
    });
  });

  describe("validation", () => {
    it("shows error when submitting with empty title", async () => {
      const { props } = renderForm();

      const submitBtn = screen.getByTestId("event-create-submit");
      await user.click(submitBtn);

      expect(screen.getByTestId("title-error")).toBeInTheDocument();
      expect(screen.getByText("Title is required")).toBeInTheDocument();
      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it("clears title error when user types", async () => {
      renderForm();

      // Trigger error
      const submitBtn = screen.getByTestId("event-create-submit");
      await user.click(submitBtn);
      expect(screen.getByTestId("title-error")).toBeInTheDocument();

      // Type in title
      const titleInput = screen.getByTestId("event-title-input");
      await user.type(titleInput, "a");

      // Error should be gone
      expect(screen.queryByTestId("title-error")).not.toBeInTheDocument();
    });

    it("shows error when end time is before start time", async () => {
      renderForm();

      const titleInput = screen.getByTestId("event-title-input");
      await user.type(titleInput, "Test Event");

      const endTimeInput = screen.getByTestId("event-end-time-input");
      await user.clear(endTimeInput);
      await user.type(endTimeInput, "08:00");

      const submitBtn = screen.getByTestId("event-create-submit");
      await user.click(submitBtn);

      expect(screen.getByTestId("end-time-error")).toBeInTheDocument();
    });
  });

  describe("submission", () => {
    it("calls onSubmit with payload when form is valid", async () => {
      const onSubmit = vi.fn();
      renderForm({ onSubmit });

      const titleInput = screen.getByTestId("event-title-input");
      await user.type(titleInput, "Sprint Planning");

      const descInput = screen.getByTestId("event-description-input");
      await user.type(descInput, "Weekly planning");

      const locInput = screen.getByTestId("event-location-input");
      await user.type(locInput, "Room 3");

      const submitBtn = screen.getByTestId("event-create-submit");
      await user.click(submitBtn);

      expect(onSubmit).toHaveBeenCalledTimes(1);
      const payload = onSubmit.mock.calls[0][0] as CreateEventPayload;
      expect(payload.summary).toBe("Sprint Planning");
      expect(payload.description).toBe("Weekly planning");
      expect(payload.location).toBe("Room 3");
      expect(payload.source).toBe("ui");
    });

    it("shows 'Creating...' text when submitting is true", () => {
      renderForm({ submitting: true });
      expect(screen.getByTestId("event-create-submit")).toHaveTextContent("Creating...");
    });

    it("disables inputs when submitting", () => {
      renderForm({ submitting: true });
      expect(screen.getByTestId("event-title-input")).toBeDisabled();
      expect(screen.getByTestId("event-description-input")).toBeDisabled();
      expect(screen.getByTestId("event-create-submit")).toBeDisabled();
    });
  });

  describe("cancellation", () => {
    it("calls onCancel when overlay is clicked", async () => {
      const onCancel = vi.fn();
      renderForm({ onCancel });

      const overlay = screen.getByTestId("event-create-overlay");
      await user.click(overlay);

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("calls onCancel when X button is clicked", async () => {
      const onCancel = vi.fn();
      renderForm({ onCancel });

      // The X button has aria-label="Cancel"
      // There are two cancel buttons, get the X one
      const closeBtns = screen.getAllByRole("button", { name: /cancel/i });
      const xBtn = closeBtns.find((btn) => btn.textContent === "X")!;
      expect(xBtn).toBeTruthy();
      await user.click(xBtn);

      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe("error display", () => {
    it("shows error banner when error prop is set", () => {
      renderForm({ error: "Server is unavailable" });
      expect(screen.getByTestId("event-create-error")).toBeInTheDocument();
      expect(screen.getByText("Server is unavailable")).toBeInTheDocument();
    });

    it("does not show error banner when error is null", () => {
      renderForm({ error: null });
      expect(screen.queryByTestId("event-create-error")).not.toBeInTheDocument();
    });
  });
});
