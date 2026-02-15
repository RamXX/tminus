/**
 * Dev-only entry point for wrangler dev.
 *
 * The main index.ts exports named constants (API_VERSION, ErrorCode, etc.)
 * which workerd rejects as invalid map entries in module format.
 * This thin wrapper re-exports only the default handler and DO classes
 * that workerd expects.
 *
 * Usage: wrangler dev --port 8787 (with main = "src/dev-entry.ts" in wrangler.toml)
 * or:    wrangler dev src/dev-entry.ts --port 8787
 */

export { UserGraphDO } from "@tminus/do-user-graph";
export { AccountDO } from "@tminus/do-account";
export { default } from "./index";
