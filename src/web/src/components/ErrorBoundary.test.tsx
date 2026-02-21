/**
 * ErrorBoundary unit tests.
 *
 * Verifies:
 * - Renders children when no error
 * - Catches render errors and shows default retry UI
 * - Retry button resets error state and re-renders children
 * - Custom fallback renders when provided
 *
 * Note: React 19 in development mode re-throws errors from error boundaries
 * as uncaught exceptions during concurrent rendering recovery. We suppress
 * those via window.addEventListener("error", ...) to keep test output clean.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

// Suppress React's noisy error boundary console output during tests
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

// Handler to swallow React 19 concurrent rendering recovery exceptions
function swallowErrorBoundaryRethrows(event: ErrorEvent) {
  if (
    event.message?.includes("concurrent rendering") ||
    event.error?.message?.includes("render error") ||
    event.error?.message?.includes("render fails")
  ) {
    event.preventDefault();
  }
}

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  window.addEventListener("error", swallowErrorBoundaryRethrows);
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  window.removeEventListener("error", swallowErrorBoundaryRethrows);
});

/** A component that throws on render when `shouldThrow` is true. */
function ThrowingChild({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error("Test render error");
  }
  return <div>Child content is fine</div>;
}

describe("ErrorBoundary", () => {
  it("renders children when no error occurs", () => {
    render(
      <ErrorBoundary>
        <div>Normal content</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("Normal content")).toBeInTheDocument();
  });

  it("shows default error UI when a child throws", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Test render error")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
  });

  it("retry button resets the error state so children can re-render", () => {
    // Use an external ref to control throwing behavior.
    // The key trick: after retry, the ErrorBoundary resets its state
    // and re-renders children. If children still throw, the error UI
    // returns. We test the MECHANISM (reset clears error state) by
    // verifying what renders after clicking retry with a non-throwing child.
    //
    // We'll render with a throwing child first, then use rerender to supply
    // a non-throwing child after clicking retry.
    const { rerender } = render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>,
    );

    // Error UI should be showing
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Test render error")).toBeInTheDocument();

    // Supply a non-throwing child, then click retry
    rerender(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={false} />
      </ErrorBoundary>,
    );

    // At this point the error boundary still shows error UI because its
    // internal state hasn't been reset. Click retry to clear it.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });

    // After reset, the ErrorBoundary renders children again (now non-throwing)
    expect(screen.getByText("Child content is fine")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });

  it("uses custom fallback when provided", () => {
    const fallbackFn = vi.fn((error: Error, reset: () => void) => (
      <div>
        <span>Custom error: {error.message}</span>
        <button onClick={reset}>Custom retry</button>
      </div>
    ));

    render(
      <ErrorBoundary fallback={fallbackFn}>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>,
    );

    // React 19 may call getDerivedStateFromError multiple times during
    // concurrent rendering recovery, so we verify it was called at least
    // once and produced the expected UI.
    expect(fallbackFn).toHaveBeenCalled();
    expect(
      screen.getByText("Custom error: Test render error"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Custom retry" }),
    ).toBeInTheDocument();
  });

  it("logs error to console.error", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>,
    );

    // console.error is called by React and by our componentDidCatch
    expect(console.error).toHaveBeenCalled();
  });
});
