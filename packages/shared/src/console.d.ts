/**
 * Minimal ambient type declarations for console methods.
 *
 * console is a standardized API available in all JavaScript runtimes
 * (browsers, Node.js, Cloudflare Workers, Deno, Bun). The shared package
 * uses `types: []` in tsconfig to avoid pulling in environment-specific
 * types, so we declare just the subset we need.
 */

declare const console: {
  log(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
  info(...data: unknown[]): void;
  debug(...data: unknown[]): void;
  trace(...data: unknown[]): void;
  table(data: unknown): void;
};
