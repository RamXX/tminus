/**
 * Design system component index.
 *
 * Re-exports all shadcn/ui-style primitives for convenient imports:
 *   import { Button, Card, Badge } from "../components/ui";
 */
export { Button, type ButtonProps, buttonVariants } from "./button";
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./card";
export { Badge, type BadgeProps, badgeVariants } from "./badge";
export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "./dialog";
export { toast, Toaster } from "./toast";
export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "./tooltip";
export { Skeleton } from "./skeleton";
export { Separator, type SeparatorProps } from "./separator";
