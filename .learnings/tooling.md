# Tooling Learnings

## [Added from Epic TM-as6 retro - 2026-02-14]

### workerd rejects named exports from worker entrypoints

**Priority:** Critical

**Context:** E2E validation (TM-as6.10) discovered that workerd rejects module workers with non-handler/non-DO-class named exports (e.g., export const API_VERSION, ErrorCode, successEnvelope). The fix is a thin dev-entry.ts that only re-exports default + DO classes.

**Recommendation:** For all Worker entrypoints:
- NEVER export constants, types, or utility functions from index.ts
- Move exports to separate modules (e.g., constants.ts, errors.ts)
- Use a thin dev-entry.ts for local development that only re-exports default handler + DO classes
- Verify production wrangler deploy doesn't have the same issue (investigate in TM-as6.10 follow-up)
- For Phase 2B (MCP), 2C (UI), 2D (Trips): structure workers from the start with no named exports from index.ts

**Applies to:** All worker stories in Phase 2B, 2C, 2D

**Source stories:** TM-as6.10

### ulid package requires nodejs_compat flag in Workers runtime

**Priority:** Critical

**Context:** E2E validation (TM-as6.10) discovered that the ulid package uses Node.js crypto.randomBytes internally, which doesn't exist in Workers runtime. Must use --compatibility-flags=nodejs_compat when running wrangler dev locally.

**Recommendation:** For all Workers that generate IDs with ulid:
- Add `compatibility_flags = ["nodejs_compat"]` to wrangler.toml (all environments)
- OR switch to a Workers-native ID generation library (e.g., uuid with Web Crypto)
- Verify the flag is in production wrangler.toml before Phase 2 deployment
- Document this requirement in PLAN.md or worker README

**Applies to:** All workers in Phase 2B, 2C, 2D that generate IDs

**Source stories:** TM-as6.10

### DOs must implement fetch(), not handleFetch()

**Priority:** Critical

**Context:** E2E validation (TM-as6.10) discovered that UserGraphDO.handleFetch() is named "handleFetch" not "fetch", which causes "Handler does not export a fetch() function" in workerd. This blocks wrangler dev for any endpoint that calls a DO.

**Recommendation:** For all Durable Objects:
- Method MUST be named `fetch()`, not `handleFetch()`
- Verify DO entrypoints with `wrangler dev` before integration testing
- SR. PM should include "DO method is named fetch()" as embedded context in all DO stories

**Applies to:** All DO stories; Phase 3 GroupScheduleDO

**Source stories:** TM-as6.10

### Wrangler per-environment configs have no inheritance

**Priority:** Critical

**Context:** Multi-environment wrangler config (TM-as6.5) revealed that each [env.X] section is a complete override, not an inheritance. Must FULLY re-declare all bindings (D1, KV, queues, DOs, workflows, triggers, limits).

**Recommendation:** For multi-environment worker configs:
- Each [env.staging] and [env.production] section must FULLY re-declare all bindings
- DO script_name must use env-suffixed worker name (tminus-api-staging, not tminus-api)
- Queue consumer configs must reference env-suffixed queue names
- Workflow names need env suffix (workflows are deployed per-worker)
- Consider a codegen script to generate env sections from a canonical config (reduces drift)

**Applies to:** All new workers in Phase 2B, 2C, 2D; Phase 3+ workers

**Source stories:** TM-as6.5

### Placeholder IDs in wrangler.toml block deployment

**Priority:** Critical

**Context:** Multiple stories (TM-as6.5, TM-as6.7, TM-as6.8, TM-xyl) noted that KV namespace IDs and D1 database IDs are still placeholders (placeholder-sessions-id, STAGING_DB_ID_PLACEHOLDER, etc.). These must be replaced with real IDs before deployment.

**Recommendation:** Before any deployment story:
- Create real KV namespaces with `wrangler kv namespace create <name> --env <env>`
- Create real D1 databases with `wrangler d1 create <name>` (once per environment)
- Replace ALL placeholders in wrangler.toml files
- Add a make check-placeholders target that greps for PLACEHOLDER and fails if found
- SR. PM should include "verify no placeholder IDs in wrangler.toml" as AC in deployment stories

**Applies to:** Phase 2B, 2C, 2D deployment stories

**Source stories:** TM-as6.5, TM-as6.7, TM-as6.8, TM-xyl

### Cloudflare DNS API returns arrays even for single record lookups

**Priority:** Important

**Context:** DNS automation (TM-as6.6) discovered that Cloudflare DNS API returns results as an array even for single record lookups. Must use result?.[0] ?? null to handle both empty and populated responses uniformly.

**Recommendation:** For all Cloudflare API wrappers:
- Always treat API results as arrays, even when requesting a single item
- Use optional chaining + nullish coalescing: `result?.[0] ?? null`
- Handle empty arrays as "not found" gracefully
- Document API behavior in code comments

**Applies to:** All Cloudflare API integration code (DNS, KV, D1, R2, etc.)

**Source stories:** TM-as6.6

### Proxied CNAME records route through Cloudflare regardless of target

**Priority:** Important

**Context:** DNS automation (TM-as6.6) discovered that Cloudflare proxied CNAME records route traffic through CF to Workers regardless of the CNAME target. Pointing at the zone apex (tminus.ink) is a clean convention since the target is never contacted when proxied.

**Recommendation:** For Worker DNS records:
- Use proxied CNAME pointing to zone apex (e.g., api.tminus.ink CNAME tminus.ink)
- Do NOT use A records with placeholder IPs (192.0.2.1) unless required
- Proxied CNAME is clearer intent than A record with RFC 5737 TEST-NET-1 IP
- Document why CNAME target doesn't matter (proxied = traffic routed to Worker)

**Applies to:** All Worker DNS automation; Phase 2B, 2C, 2D subdomain creation

**Source stories:** TM-as6.6

### A and CNAME records cannot coexist for the same hostname

**Priority:** Important

**Context:** DNS automation (TM-as6.6) discovered that Cloudflare does not allow both an A and CNAME record for the same hostname. When migrating from A records to CNAME records, you must DELETE the A record first. The ensureProxiedRecord function handles this automatically with a "migrated" action.

**Recommendation:** For DNS automation that migrates record types:
- Check for existing A record before creating CNAME
- Delete A record first, then create CNAME (two API calls)
- Return "migrated" action in response (not "created")
- Document the migration path in code comments

**Applies to:** DNS automation scripts; any future DNS record type migrations

**Source stories:** TM-as6.6

### wrangler secret put is an upsert (always safe to re-run)

**Priority:** Useful

**Context:** Secrets management (TM-as6.8) discovered that Cloudflare `wrangler secret put` is an upsert -- always safe to re-run. This makes secrets deployment inherently idempotent.

**Recommendation:** For secrets deployment scripts:
- No need to check if secret exists before setting
- Re-running deployment script is safe (upsert semantics)
- Document idempotency in script comments
- Consider a make secrets-sync target for local -> remote secret sync

**Applies to:** All secrets deployment scripts; CI/CD pipelines

**Source stories:** TM-as6.8

### wrangler --name uses base name, not env-suffixed name

**Priority:** Useful

**Context:** Secrets management (TM-as6.8) discovered that when using `--name` and `--env` together with wrangler, the worker name is the *base* name (tminus-api), not the env-suffixed name (tminus-api-production). Wrangler resolves the environment internally.

**Recommendation:** For wrangler CLI scripts that target specific environments:
- Use base worker name with --name (e.g., tminus-api)
- Add --env <env> separately (wrangler resolves internally)
- Do NOT construct env-suffixed names manually
- Document wrangler's environment resolution behavior

**Applies to:** All wrangler CLI automation scripts

**Source stories:** TM-as6.8

### Workers without HTTP routes cannot have health checks

**Priority:** Important

**Context:** Stage-to-prod deployment pipeline (TM-as6.7) discovered that not all Cloudflare Workers have HTTP routes. Queue consumers and cron workers are triggered by queues/cron schedules and have no /health endpoint. Health checks must only target workers with [[routes]] in their wrangler.toml (api, oauth, webhook).

**Recommendation:** For deployment pipeline health checks:
- Only check workers with [[routes]] in wrangler.toml
- Document which workers are HTTP-routed vs event-driven
- Queue consumers and cron workers are verified via logs/metrics, not HTTP
- Consider a worker metadata config that declares health check eligibility

**Applies to:** All deployment pipeline scripts; CI/CD health checks

**Source stories:** TM-as6.7

### vitest does not have toEndWith matcher

**Priority:** Useful

**Context:** Stage-to-prod deployment pipeline (TM-as6.7) discovered that Vitest does not have a toEndWith matcher. Use toMatch(/\/health$/) instead for suffix matching.

**Recommendation:** For vitest assertions on string suffixes:
- Use `expect(str).toMatch(/suffix$/)` instead of `toEndWith()`
- Use `expect(str).toMatch(/^prefix/)` for prefix matching
- Consider extracting common matchers to shared test utils if pattern recurs

**Applies to:** All vitest tests

**Source stories:** TM-as6.7

---

## [Added from Epic TM-4qw retro - 2026-02-14]

### Wrangler Local D1 Setup is Non-Obvious

**Priority:** Important

**Context:** TM-4qw.7 discovered that wrangler dev --local stores D1 in .wrangler/state/v3/d1/, and schema migrations must be applied via `wrangler d1 execute` not direct sqlite3 commands.

**Recommendation:** Document the local D1 setup pattern in a runbook or README:
1. Wrangler creates database ID directories automatically
2. Migrations must go through `wrangler d1 execute` to match the ID path
3. Direct sqlite3 access is read-only for debugging

Add a `make setup-local-d1` target that runs the setup script for consistency.

**Applies to:** All local development setup documentation

**Source stories:** TM-4qw.7

### Local File Watcher Interference

**Priority:** Nice-to-have

**Context:** TM-4qw.5 noted a file watcher injecting uncommitted code from TM-4qw.6 into index.ts after git checkout. Required `git checkout HEAD --` before test runs.

**Recommendation:** Investigate and disable any auto-save/auto-format watchers in the development environment that run during git operations. If using an IDE plugin, configure it to respect .gitignore or disable during test runs.

This is a local environment issue, not a code issue, but it caused false test failures.

**Applies to:** Local development setup

**Source stories:** TM-4qw.5

---

## [Added from Epic TM-lfy retro - 2026-02-15]

### watchOS 10+ uses WidgetKit (not ClockKit) for complications

**Priority:** Important

**Context:** Apple deprecated ClockKit in watchOS 10 in favor of WidgetKit-based complications. The old ComplicationFamily enum is replaced by accessoryCircular, accessoryRectangular, accessoryInline widget families.

**Recommendation:** For Apple Watch complication stories:
- Use WidgetKit timeline providers (not ClockKit complication data sources)
- Target watchOS 10+ and use accessory* families
- Document this in D&F for any future watchOS features
- WidgetKit timeline model provides system-managed updates (better power efficiency)

**Applies to:** All Apple Watch complication stories

**Source stories:** TM-lfy.4
