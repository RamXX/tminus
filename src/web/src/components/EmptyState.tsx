/**
 * EmptyState -- placeholder for empty lists / no-data scenarios.
 *
 * Shows an icon, title, description, and optional action button.
 */
import { type ReactNode } from "react";
import { cn } from "../lib/utils";

export interface EmptyStateProps {
  /** Lucide icon or custom SVG element. */
  icon?: ReactNode;
  title: string;
  description?: string;
  /** Optional action slot (e.g., a Button). */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border p-12 text-center",
        className,
      )}
    >
      {icon && (
        <div className="text-muted-foreground [&>svg]:h-10 [&>svg]:w-10">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {description && (
        <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
