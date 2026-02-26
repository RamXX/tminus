/**
 * Toast notification component.
 *
 * Lightweight imperative toast system. No external dependency needed --
 * this is a self-contained React component with a module-level queue
 * exposed via toast() / toast.success() / toast.error().
 */
import { useState, useEffect, useCallback, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToastVariant = "default" | "success" | "destructive" | "warning";

interface ToastItem {
  id: string;
  message: ReactNode;
  variant: ToastVariant;
  duration: number;
}

// ---------------------------------------------------------------------------
// Module-level queue + subscriber
// ---------------------------------------------------------------------------

let nextId = 0;
let subscriber: ((item: ToastItem) => void) | null = null;

function dispatch(message: ReactNode, variant: ToastVariant, duration = 4000) {
  const item: ToastItem = {
    id: `toast-${++nextId}`,
    message,
    variant,
    duration,
  };
  subscriber?.(item);
}

/**
 * Show a toast notification.
 *
 * @example
 *   toast("Saved successfully");
 *   toast.success("Account linked");
 *   toast.error("Failed to sync");
 */
export function toast(message: ReactNode, duration?: number) {
  dispatch(message, "default", duration);
}
toast.success = (message: ReactNode, duration?: number) =>
  dispatch(message, "success", duration);
toast.error = (message: ReactNode, duration?: number) =>
  dispatch(message, "destructive", duration);
toast.warning = (message: ReactNode, duration?: number) =>
  dispatch(message, "warning", duration);

// ---------------------------------------------------------------------------
// Variant styles
// ---------------------------------------------------------------------------

const variantClasses: Record<ToastVariant, string> = {
  default: "border-border bg-card text-card-foreground",
  success: "border-success/50 bg-success/10 text-success",
  destructive: "border-destructive/50 bg-destructive/10 text-destructive",
  warning: "border-warning/50 bg-warning/10 text-warning",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Mount once at the app root to enable toast(). */
export function Toaster() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback((item: ToastItem) => {
    setToasts((prev) => [...prev, item]);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Register this component as the subscriber
  useEffect(() => {
    subscriber = addToast;
    return () => {
      subscriber = null;
    };
  }, [addToast]);

  // Auto-dismiss
  useEffect(() => {
    if (toasts.length === 0) return;
    const oldest = toasts[0];
    const timer = setTimeout(() => removeToast(oldest.id), oldest.duration);
    return () => clearTimeout(timer);
  }, [toasts, removeToast]);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            // TODO: Migrate toast entrance/exit to Framer Motion (motion + AnimatePresence)
            // when framer-motion is installed (TM-lshm.1). Use slideInRight pattern:
            //   initial: { opacity: 0, x: 24 }
            //   animate: { opacity: 1, x: 0, transition: { duration: 0.3, ease: "easeOut" } }
            //   exit: { opacity: 0, x: 24, transition: { duration: 0.2 } }
            "flex items-center gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg animate-in slide-in-from-right-6 duration-300",
            variantClasses[t.variant],
          )}
          role="status"
        >
          <span className="flex-1">{t.message}</span>
          <button
            onClick={() => removeToast(t.id)}
            className="rounded-sm opacity-70 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
