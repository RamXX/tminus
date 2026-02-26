/**
 * ErrorBoundary -- catches React render errors and shows retry UI.
 *
 * Class component is required because React's error boundary API
 * only works with componentDidCatch / getDerivedStateFromError.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

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
            "flex flex-col items-center justify-center gap-4 rounded-lg border border-destructive/50 bg-background p-8 text-center",
          )}
        >
          <h2 className="text-lg font-semibold text-foreground">
            Something went wrong
          </h2>
          <p className="max-w-md text-destructive text-sm">
            {error.message || "An unexpected error occurred."}
          </p>
          <Button type="button" onClick={this.handleReset}>
            Try again
          </Button>
        </div>
      );
    }

    return children;
  }
}
