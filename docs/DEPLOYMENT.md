# T-Minus Deployment Runbook

Production deployment guide for T-Minus -- a Cloudflare Workers-based temporal and relational intelligence engine.

This runbook covers the complete deployment lifecycle: prerequisites, first-time setup, regular deployments, targeted operations, rollback procedures, and troubleshooting.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [First-Time Setup](#2-first-time-setup)
3. [Regular Deployment](#3-regular-deployment)
4. [Targeted Deployment](#4-targeted-deployment)
5. [Rollback](#5-rollback)
6. [Troubleshooting](#6-troubleshooting)

---

## 1. Prerequisites

### Required Tools

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 18+ | `brew install node` or `nvm use 18` |
| pnpm | 8+ | `npm install -g pnpm` |
| wrangler | 3+ | Installed via `pnpm install` (project devDep) |
| curl | any | Pre-installed on macOS/Linux |
| bash | 4+ | Pre-installed (macOS: `brew install bash` for 5+) |
| python3 | 3.8+ | Required by `validate-deployment.sh` for JSON parsing |

### Required Environment Variables

Copy `.env.example` to `.env` and populate all values:

```bash
cp .env.example .env
```

| Variable | Purpose | Where to get it |
|----------|---------|-----------------|
| `CLOUDFLARE_API_TOKEN` | Wrangler auth token (Workers/D1/Queues/DNS edit permissions) | [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID | Dashboard sidebar |
| `TMINUS_ZONE_ID` | Zone ID for `tminus.ink` | Dashboard > tminus.ink > Overview sidebar |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 client ID | [GCP Credentials](https://console.cloud.google.com/apis/credentials) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 client secret | Same as above |
| `MS_CLIENT_ID` | Microsoft Entra ID client ID | [Entra ID](https://entra.microsoft.com/) > App registrations |
| `MS_CLIENT_SECRET` | Microsoft Entra ID client secret | Same as above |
| `JWT_SECRET` | JWT signing/verification secret | Generate: `openssl rand -base64 32` |
| `MASTER_KEY` | Envelope encryption master key (DEK wrapping) | Generate: `openssl rand -base64 32` |

**Critical:** `JWT_SECRET` and `MASTER_KEY` must be identical across `tminus-api` and `tminus-oauth` workers. The secrets setup script handles this automatically.

### Pre-Deployment Checks

```bash
# 1. Verify .env exists and is populated
test -f .env && echo "OK" || echo "MISSING: copy .env.example to .env"

# 2. Verify wrangler is authenticated
source .env && npx wrangler whoami

# 3. Verify no placeholder IDs in wrangler.toml files
make check-placeholders

# 4. Install dependencies
make install
```

---

## 2. First-Time Setup

These steps are performed once when setting up the project for the first time. Skip this section for subsequent deployments.

### 2.1 Create Infrastructure Resources

KV namespaces, R2 buckets, and queues are configured in each worker's `wrangler.toml`. Cloudflare creates these automatically on first `wrangler deploy`. However, if wrangler.toml references specific IDs (not auto-created), create them manually:

```bash
# KV namespaces (if not already created)
npx wrangler kv namespace create "sessions" --env staging
npx wrangler kv namespace create "sessions" --env production

# Update wrangler.toml with the returned namespace IDs
```

### 2.2 Replace Placeholder IDs

All `wrangler.toml` files must have real resource IDs, not placeholders:

```bash
# Check for remaining placeholders
make check-placeholders

# If placeholders exist, replace them with real IDs from step 2.1
# The check-placeholders target greps for "placeholder" or "PLACEHOLDER"
```

### 2.3 Set Up DNS Records

DNS records create proxied CNAME entries for all worker subdomains on `tminus.ink`:

**Production subdomains:** `api.tminus.ink`, `app.tminus.ink`, `mcp.tminus.ink`, `webhooks.tminus.ink`, `oauth.tminus.ink`

**Staging subdomains:** `api-staging.tminus.ink`, `app-staging.tminus.ink`, `mcp-staging.tminus.ink`, `webhooks-staging.tminus.ink`, `oauth-staging.tminus.ink`

```bash
# Production DNS only
make deploy-dns

# Staging DNS only
make dns-setup-staging

# Both environments
make dns-setup-all
```

The DNS setup script (`scripts/dns-setup.mjs`) is idempotent. It creates records if missing, updates if changed, and skips if already correct. It also migrates legacy A records to CNAME records automatically.

**Note:** Proxied CNAME records route traffic through Cloudflare to Workers regardless of the CNAME target. The target (`tminus.ink`) is never contacted when proxied.

### 2.4 Set Up GCP Project

1. Create a GCP project at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable the Google Calendar API
3. Create OAuth 2.0 credentials (Web application type)
4. Set authorized redirect URIs:
   - `https://oauth.tminus.ink/callback/google` (production)
   - `https://oauth-staging.tminus.ink/callback/google` (staging)
5. Copy Client ID and Client Secret to `.env`

### 2.5 Deploy Secrets

Secrets are deployed via `wrangler secret put` with values piped via stdin (never exposed on command line):

```bash
# Both environments
make secrets-setup

# Production only
make secrets-setup-production

# Staging only
make secrets-setup-staging

# Dry run (see what would be deployed)
make secrets-setup-dry-run
```

**Secret-to-worker mapping:**

| Secret | Workers | Purpose |
|--------|---------|---------|
| `JWT_SECRET` | api, oauth | JWT signing/verification |
| `MASTER_KEY` | api, oauth | Envelope encryption (DEK wrapping) |
| `GOOGLE_CLIENT_ID` | api, oauth | Google OAuth flows + token refresh |
| `GOOGLE_CLIENT_SECRET` | api, oauth | Google OAuth flows + token refresh |
| `MS_CLIENT_ID` | api, oauth | Microsoft OAuth flows + token refresh |
| `MS_CLIENT_SECRET` | api, oauth | Microsoft OAuth flows + token refresh |

Secrets are idempotent (upsert semantics). Safe to re-run at any time.

### 2.6 Run D1 Migrations

```bash
make deploy-d1-migrate
```

This runs `wrangler d1 migrations apply tminus-registry --remote` using `wrangler-d1.toml`. Migration files live in `migrations/d1-registry/`.

---

## 3. Regular Deployment

### 3.1 Full Pipeline (Recommended)

The full pipeline builds, deploys to staging, runs health checks and smoke tests, then promotes to production:

```bash
make deploy
```

This runs `scripts/promote.mjs` which executes the following stages in order:

| # | Stage | Description | Gate |
|---|-------|-------------|------|
| 1 | Build | `pnpm run build` | Build must succeed |
| 2 | Migrate Staging | D1 migrations for `tminus-registry-staging` | Migrations must apply cleanly |
| 3 | Deploy Staging | Deploy all 9 workers to staging | All workers deploy successfully |
| 4 | Health Staging | `GET /health` on all HTTP workers | All return 200 with enriched format |
| 5 | Smoke Staging | Register/login/protected-call flow | All smoke tests pass |
| 6 | Migrate Production | D1 migrations for `tminus-registry` | Migrations must apply cleanly |
| 7 | Deploy Production | Deploy all 9 workers to production | All workers deploy successfully |
| 8 | Health Production | `GET /health` on all HTTP workers | All return 200 with enriched format |
| 9 | Smoke Production | Register/login/protected-call flow | All smoke tests pass |

Each stage is a gate: if it fails, subsequent stages do not run.

### 3.2 Worker Deploy Order

Workers are deployed in dependency order. **API must be first** because other workers reference its Durable Objects via `script_name`:

| Order | Worker | Hosts | Depends On |
|-------|--------|-------|------------|
| 1 | `tminus-api` | UserGraphDO, AccountDO | -- |
| 2 | `tminus-sync-consumer` | -- | DOs on api |
| 3 | `tminus-write-consumer` | -- | DOs on api |
| 4 | `tminus-oauth` | OnboardingWorkflow | DOs on api |
| 5 | `tminus-webhook` | -- | Queues |
| 6 | `tminus-cron` | ReconcileWorkflow | DOs on api |
| 7 | `tminus-app-gateway` | -- | API via service binding |
| 8 | `tminus-mcp` | -- | API via service binding |
| 9 | `tminus-push` | -- | DOs on api |

### 3.3 HTTP Workers (Health-Checkable)

Only workers with HTTP routes have `/health` endpoints:

| Worker | Production URL | Staging URL |
|--------|----------------|-------------|
| api | `https://api.tminus.ink` | `https://api-staging.tminus.ink` |
| oauth | `https://oauth.tminus.ink` | `https://oauth-staging.tminus.ink` |
| webhook | `https://webhooks.tminus.ink` | `https://webhooks-staging.tminus.ink` |
| app-gateway | `https://app.tminus.ink` | `https://app-staging.tminus.ink` |
| mcp | `https://mcp.tminus.ink` | `https://mcp-staging.tminus.ink` |

Workers without HTTP routes (sync-consumer, write-consumer, cron, push) are triggered by queues or cron schedules and cannot be health-checked via HTTP.

### 3.4 Dry Run

Preview the full pipeline plan without executing:

```bash
make deploy-promote-dry-run
```

### 3.5 Post-Deployment Validation

After the pipeline completes, run independent validation:

```bash
# Validate all worker health endpoints (enriched JSON format)
make validate-deployment

# Run smoke tests (health + auth enforcement + register/login flow)
make smoke-test
```

The validation script (`scripts/validate-deployment.sh`) verifies:
1. HTTP 200 response from each health endpoint
2. Enriched JSON format with `ok:true`, `data.status`, `data.environment`, `data.worker`, and `data.bindings`
3. Status is "healthy" or "degraded"
4. Falls back to `--resolve` with Cloudflare anycast IP (`104.18.0.0`) if DNS hasn't propagated

The smoke test (`scripts/smoke-test.mjs`) verifies:
1. `GET /health` returns 200 with correct envelope
2. `GET /v1/events` without JWT returns 401 (auth enforcement)
3. `POST /v1/auth/register` creates a user and returns JWT
4. `POST /v1/auth/login` authenticates and returns JWT
5. `GET /v1/events` with JWT returns 200 (protected endpoint access)

---

## 4. Targeted Deployment

### 4.1 Deploy a Single Worker

Deploy a specific worker without running the full pipeline:

```bash
cd workers/<worker-name>
npx wrangler deploy --env production

# Examples:
cd workers/api && npx wrangler deploy --env production
cd workers/oauth && npx wrangler deploy --env staging
```

**Warning:** Deploying a single worker bypasses health checks and smoke tests. Always validate afterward:

```bash
make validate-deployment
```

### 4.2 Deploy Secrets Only

```bash
# All secrets to both environments
make secrets-setup

# Production only
make secrets-setup-production

# Staging only
make secrets-setup-staging
```

### 4.3 Run D1 Migrations Only

```bash
# Production
make deploy-d1-migrate

# Staging (manually specify the database)
source .env && npx wrangler d1 migrations apply tminus-registry-staging --remote --env staging --config wrangler-d1.toml
```

### 4.4 Deploy DNS Only

```bash
# Production
make deploy-dns

# Staging
make dns-setup-staging

# Both
make dns-setup-all
```

### 4.5 Staging Only

Deploy to staging without promoting to production:

```bash
make deploy-stage
```

### 4.6 Production Only (Skip Staging)

Deploy directly to production when staging has already been verified:

```bash
make deploy-prod
```

---

## 5. Rollback

### 5.1 Worker Rollback

Cloudflare Workers support instant rollback to the previous deployment version:

```bash
# Rollback a specific worker
npx wrangler rollback --name tminus-api --env production

# Rollback multiple workers (reverse deploy order for safety)
for worker in push mcp app-gateway cron webhook oauth write-consumer sync-consumer api; do
  echo "Rolling back tminus-${worker}..."
  npx wrangler rollback --name "tminus-${worker}" --env production
done
```

**When to rollback vs fix-forward:**

| Situation | Action |
|-----------|--------|
| Health checks fail after deploy | Rollback immediately |
| Smoke tests fail (auth broken) | Rollback immediately |
| Error rate spike in production | Rollback, then investigate |
| Minor bug found in new feature | Fix-forward (new deploy) |
| Data corruption risk | Rollback immediately |

**Rollback verifies:** After rolling back, always validate:

```bash
make validate-deployment
make smoke-test
```

### 5.2 D1 Migration Rollback

D1 migrations are **forward-only**. There is no `wrangler d1 migrations rollback` command.

To reverse a D1 migration:

1. **Write a compensating migration** that undoes the changes:

```sql
-- migrations/d1-registry/NNNN_rollback_description.sql
-- Reverse migration NNNN: <describe what this reverses>

-- If the migration added a column:
ALTER TABLE table_name DROP COLUMN column_name;

-- If the migration created a table:
DROP TABLE IF EXISTS table_name;

-- If the migration added an index:
DROP INDEX IF EXISTS index_name;
```

2. **Apply the compensating migration:**

```bash
make deploy-d1-migrate
```

3. **Test the rollback** on staging first:

```bash
# Apply to staging, verify, then production
source .env && npx wrangler d1 migrations apply tminus-registry-staging --remote --env staging --config wrangler-d1.toml
```

**Warning:** SQLite (D1) does not support all `ALTER TABLE` operations. Dropping columns requires SQLite 3.35.0+. If a column drop is not supported, the compensating migration may need to recreate the table.

### 5.3 Secret Rotation

If a secret is compromised:

1. **Generate new values:**

```bash
# For JWT_SECRET or MASTER_KEY:
openssl rand -base64 32
```

2. **Update `.env`** with the new value.

3. **Deploy new secrets:**

```bash
make secrets-setup-production
```

4. **Redeploy affected workers** (secrets take effect on next deployment or within ~30 seconds for active workers):

```bash
# JWT_SECRET and MASTER_KEY affect api and oauth
cd workers/api && npx wrangler deploy --env production
cd workers/oauth && npx wrangler deploy --env production
```

5. **For OAuth credentials** (Google/Microsoft): Also update the credentials in the respective provider console (GCP Console or Entra ID).

**Warning:** Rotating `JWT_SECRET` invalidates all existing JWTs. Users will need to re-authenticate. Rotating `MASTER_KEY` will make existing encrypted OAuth tokens unreadable -- a key migration strategy is needed for production (decrypt with old key, re-encrypt with new key).

---

## 6. Troubleshooting

### Error 1101: Worker threw a JavaScript exception

**Symptoms:** HTTP 1101 error from Cloudflare edge.

**Common causes:**
- Missing `nodejs_compat` compatibility flag in `wrangler.toml` (required for `ulid` package)
- Named exports in `index.ts` beyond the default handler and DO classes (workerd rejects these)
- Accessing an undefined binding (D1, KV, queue not configured in the environment section)

**Fix:**
1. Check `compatibility_flags = ["nodejs_compat"]` is present in the worker's `wrangler.toml` under the correct `[env.production]` section
2. Verify `index.ts` only exports the default handler and DO classes -- move constants/utilities to separate modules
3. Verify all bindings are fully declared in the `[env.production]` section (wrangler environments have NO inheritance from the top-level config)

### Durable Object Binding Errors

**Symptoms:** "Durable Object namespace ... is not defined" or "Cannot find script ..."

**Common causes:**
- API worker not deployed before consumers/oauth/cron
- `script_name` in wrangler.toml using base name instead of env-suffixed name

**Fix:**
1. Verify API worker is deployed first: `npx wrangler deployments list --name tminus-api --env production`
2. Check `script_name` in dependent workers' `wrangler.toml` uses `tminus-api-production` (not `tminus-api`) for the production environment section

### DNS Propagation Delays

**Symptoms:** `curl https://api.tminus.ink/health` returns connection refused or DNS resolution failure.

**Timeline:** DNS changes propagate within seconds for proxied Cloudflare records, but can take up to 5 minutes in edge cases.

**Fix:**
1. Verify DNS records exist: `dig api.tminus.ink +short` (should return Cloudflare IPs)
2. Use `--resolve` to bypass DNS cache: `curl --resolve "api.tminus.ink:443:104.18.0.0" https://api.tminus.ink/health`
3. Re-run DNS setup if records are missing: `make deploy-dns`

The `validate-deployment.sh` script automatically falls back to `--resolve` with Cloudflare's anycast IP if normal DNS resolution fails.

### Health Check Returns Non-Enriched Format

**Symptoms:** `validate-deployment.sh` reports `FAIL (format=legacy-json, expected enriched)`.

**Cause:** Worker is running an old version without the enriched health response (`data.environment`, `data.worker`, `data.bindings` fields).

**Fix:** Redeploy the worker to pick up the latest code:

```bash
cd workers/<worker-name> && npx wrangler deploy --env production
```

### Smoke Test Auth Flow Fails

**Symptoms:** `smoke-test.mjs` fails on register or login steps.

**Common causes:**
- D1 migrations not applied (users table missing)
- `JWT_SECRET` not set as a worker secret
- Incorrect D1 binding in production wrangler.toml

**Fix:**
1. Apply D1 migrations: `make deploy-d1-migrate`
2. Deploy secrets: `make secrets-setup-production`
3. Verify D1 binding in `workers/api/wrangler.toml` under `[env.production]`

### Viewing Worker Logs

Tail real-time logs from a deployed worker:

```bash
# Tail production logs
npx wrangler tail tminus-api-production

# Tail staging logs
npx wrangler tail tminus-api-staging

# Filter by status (errors only)
npx wrangler tail tminus-api-production --status error
```

### Queue Inspection

Queue consumers (sync-consumer, write-consumer) process messages from Cloudflare Queues. If messages are not being processed:

1. Check the worker is deployed: `npx wrangler deployments list --name tminus-sync-consumer --env production`
2. Check queue consumer configuration in the worker's `wrangler.toml`
3. Tail the consumer logs: `npx wrangler tail tminus-sync-consumer-production`

---

## Quick Reference

### Make Targets

| Target | Description |
|--------|-------------|
| `make install` | Install pnpm dependencies |
| `make build` | Build all packages |
| `make deploy` | Full staging-to-production pipeline |
| `make deploy-stage` | Deploy to staging only |
| `make deploy-prod` | Deploy to production only (skip staging) |
| `make deploy-promote-dry-run` | Preview pipeline plan |
| `make deploy-d1-migrate` | Apply D1 migrations (production) |
| `make deploy-dns` | Set up DNS records (production) |
| `make dns-setup-staging` | Set up DNS records (staging) |
| `make dns-setup-all` | Set up DNS records (both environments) |
| `make secrets-setup` | Deploy secrets (both environments) |
| `make secrets-setup-production` | Deploy secrets (production only) |
| `make secrets-setup-staging` | Deploy secrets (staging only) |
| `make secrets-setup-dry-run` | Preview secrets deployment |
| `make validate-deployment` | Validate production health endpoints |
| `make validate-deployment-staging` | Validate staging health endpoints |
| `make smoke-test` | Run production smoke tests |
| `make smoke-test-staging` | Run staging smoke tests |
| `make check-placeholders` | Verify no placeholder IDs in wrangler.toml |

### Key Scripts

| Script | Purpose |
|--------|---------|
| `scripts/promote.mjs` | Stage-to-production deployment pipeline |
| `scripts/dns-setup.mjs` | DNS record management |
| `scripts/setup-secrets.mjs` | Secrets deployment |
| `scripts/smoke-test.mjs` | API smoke tests |
| `scripts/validate-deployment.sh` | Worker health validation |

### promote.mjs Options

| Flag | Effect |
|------|--------|
| `--dry-run` | Print plan without executing |
| `--stage-only` | Deploy to staging only |
| `--prod-only` | Deploy to production only |
| `--skip-smoke` | Skip smoke tests (health checks still run) |
| `--skip-secrets` | Skip secret deployment |
| `--skip-migrations` | Skip D1 migrations |
| `--skip-build` | Skip build step |
| `--verbose`, `-v` | Verbose output |
