/**
 * Wrangler entry point for tminus-api (dev AND production).
 *
 * The main index.ts exports named constants (API_VERSION, ErrorCode, etc.)
 * which workerd rejects as invalid map entries in module format.
 * This thin wrapper re-exports only the default handler and DO classes
 * that workerd expects.
 *
 * The DO wrappers extend DurableObject from "cloudflare:workers" and
 * delegate to the testable core classes from @tminus/do-user-graph and
 * @tminus/do-account. This separation allows tests to import from
 * index.ts without depending on the cloudflare:workers runtime module.
 *
 * Usage: wrangler dev --port 8787 (uses main = "src/dev-entry.ts" in wrangler.toml)
 */

export { UserGraphDO, AccountDO } from "./do-wrappers";
export { default } from "./index";
