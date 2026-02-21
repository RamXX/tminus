/**
 * Tailwind CSS class merge utility.
 *
 * Combines clsx (conditional class names) with tailwind-merge
 * (deduplicates conflicting Tailwind utilities so the last one wins).
 */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
