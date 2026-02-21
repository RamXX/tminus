/**
 * LoadingSpinner -- animated spinner for async loading states.
 *
 * Uses a CSS animation on an SVG circle. Respects prefers-reduced-motion
 * via Tailwind's motion-reduce: utilities.
 */
import { cn } from "../lib/utils";

export interface LoadingSpinnerProps {
  /** Accessible label. Defaults to "Loading". */
  label?: string;
  /** Size class. */
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeClasses = {
  sm: "h-4 w-4",
  md: "h-8 w-8",
  lg: "h-12 w-12",
} as const;

export function LoadingSpinner({
  label = "Loading",
  size = "md",
  className,
}: LoadingSpinnerProps) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn("flex items-center justify-center", className)}
    >
      <svg
        className={cn(
          "animate-spin text-primary motion-reduce:animate-none",
          sizeClasses[size],
        )}
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
      <span className="sr-only">{label}</span>
    </div>
  );
}
