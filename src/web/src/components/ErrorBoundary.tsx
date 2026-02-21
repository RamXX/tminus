/**
 * Error Boundary component for the T-Minus SPA.
 *
 * Catches unhandled JavaScript errors anywhere in the child component tree,
 * logs them, and renders a fallback UI instead of crashing the whole app.
 *
 * Placement: wraps the entire app root so that routing errors, API failures,
 * and rendering crashes are all caught.
 *
 * React error boundaries must be class components -- there is no hook equivalent.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Props & State
// ---------------------------------------------------------------------------

export interface ErrorBoundaryProps {
  /** Child components to render when no error has occurred. */
  children: ReactNode;
  /** Optional custom fallback UI. Receives the error and a reset function. */
  fallback?: (props: { error: Error; reset: () => void }) => ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Log to console for now; production would send to error reporting service
    console.error("[ErrorBoundary] Uncaught error:", error, errorInfo);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback({
          error: this.state.error,
          reset: this.handleReset,
        });
      }

      return (
        <div
          role="alert"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            padding: "2rem",
            fontFamily: "system-ui, sans-serif",
            color: "#f1f5f9",
          }}
        >
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.75rem" }}>
            Something went wrong
          </h1>
          <p style={{ color: "#94a3b8", marginBottom: "1rem", maxWidth: "400px", textAlign: "center" }}>
            An unexpected error occurred. You can try reloading the page or resetting the application.
          </p>
          <pre
            style={{
              background: "#1e293b",
              padding: "1rem",
              borderRadius: "6px",
              fontSize: "0.75rem",
              color: "#f87171",
              maxWidth: "500px",
              overflow: "auto",
              marginBottom: "1rem",
            }}
          >
            {this.state.error.message}
          </pre>
          <button
            onClick={this.handleReset}
            style={{
              padding: "0.625rem 1.25rem",
              borderRadius: "6px",
              border: "none",
              background: "#3b82f6",
              color: "#ffffff",
              fontSize: "0.875rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
