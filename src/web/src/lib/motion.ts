/**
 * Shared Framer Motion animation variants and utilities.
 * Single source of truth for all animation timing in the app.
 *
 * Usage:
 *   import { cardVariants, staggerContainer } from '../lib/motion';
 *   <motion.div variants={cardVariants} initial="hidden" animate="visible" />
 */
import { useReducedMotion } from 'framer-motion';

// ---------------------------------------------------------------------------
// Transition presets
// ---------------------------------------------------------------------------

export const springGentle = { type: 'spring', stiffness: 200, damping: 20 } as const;
export const easeOut300 = { duration: 0.3, ease: 'easeOut' } as const;
export const easeOut200 = { duration: 0.2, ease: 'easeOut' } as const;
export const easeOut150 = { duration: 0.15, ease: [0.33, 1, 0.68, 1] } as const;

// ---------------------------------------------------------------------------
// Card entrance (stagger children)
// ---------------------------------------------------------------------------

export const staggerContainer = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.05 },
  },
} as const;

export const cardVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: {
    opacity: 1,
    y: 0,
    transition: easeOut300,
  },
} as const;

// ---------------------------------------------------------------------------
// Page fade (route transitions)
// ---------------------------------------------------------------------------

export const pageFade = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: easeOut200 },
  exit: { opacity: 0, transition: { duration: 0.15 } },
} as const;

// ---------------------------------------------------------------------------
// Modal / Dialog
// ---------------------------------------------------------------------------

export const modalVariants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: easeOut200,
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    transition: { duration: 0.15 },
  },
} as const;

// ---------------------------------------------------------------------------
// Slide-in from right (panels, toasts)
// ---------------------------------------------------------------------------

export const slideInRight = {
  hidden: { opacity: 0, x: 24 },
  visible: {
    opacity: 1,
    x: 0,
    transition: easeOut300,
  },
  exit: {
    opacity: 0,
    x: 24,
    transition: { duration: 0.2 },
  },
} as const;

// ---------------------------------------------------------------------------
// Reduced motion hook wrapper
// ---------------------------------------------------------------------------

/**
 * Returns animation config that respects prefers-reduced-motion.
 * When reduced motion is preferred, all transitions are instant (duration: 0).
 */
export function useMotionConfig() {
  const prefersReduced = useReducedMotion();

  return {
    prefersReduced,
    /** Use as transition override: transition={motionConfig.safeTransition(easeOut300)} */
    safeTransition: (transition: Record<string, unknown>) =>
      prefersReduced ? { duration: 0 } : transition,
  };
}
