/**
 * PageHeader -- consistent header pattern across all pages.
 *
 * Provides a title, optional description, and an action slot (e.g., buttons).
 */
import { type ReactNode } from "react";
import { cn } from "../lib/utils";

export interface PageHeaderProps {
  title: string;
  description?: string;
  /** Action slot rendered on the right (e.g., a Button or link). */
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {title}
        </h1>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
