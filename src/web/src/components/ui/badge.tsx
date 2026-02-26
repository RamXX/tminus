/**
 * Badge component (shadcn/ui pattern).
 */
import { type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center border text-[9px] font-semibold uppercase tracking-wider rounded px-1.5 py-0.5 transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-primary/30 bg-primary/15 text-primary",
        secondary:
          "border-border bg-secondary text-secondary-foreground",
        destructive:
          "border-destructive/30 bg-destructive/15 text-destructive",
        success:
          "border-success/30 bg-success/15 text-success",
        warning:
          "border-warning/30 bg-warning/15 text-warning",
        outline: "border-border text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
