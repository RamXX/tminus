/**
 * ErrorBoundary -- catches React render errors and shows retry UI.
 *
 * Class component is required because React's error boundary API
 * only works with componentDidCatch / getDerivedStateFromError.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { cn } from "../lib/utils";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional custom fallback. Receives the error and a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log to console so devtools / observability picks it up.
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  private handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    const { children, fallback } = this.props;

    if (error) {
      if (fallback) {
        return fallback(error, this.handleReset);
      }

      return (
        <div
          role="alert"
          className={cn(
            "flex flex-col items-center justify-center gap-4 rounded-lg border border-destructive/50 bg-destructive/5 p-8 text-center",
          )}
        >
          <h2 className="text-lg font-semibold text-foreground">
            Something went wrong
          </h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {error.message || "An unexpected error occurred."}
          </p>
          <button
            type="button"
            onClick={this.handleReset}
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Try again
          </button>
        </div>
      );
    }

    return children;
  }
}
