/**
 * Minimal ambient type declaration for console.warn.
 *
 * console is a standardized API available in all JavaScript runtimes
 * (browsers, Node.js, Cloudflare Workers, Deno, Bun). The shared package
 * uses `types: []` in tsconfig to avoid pulling in environment-specific
 * types, so we declare just the subset we need.
 */

declare const console: {
  warn(...data: unknown[]): void;
};
