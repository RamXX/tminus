# Deployment Runbook

Production deployment guide for T-Minus -- a Cloudflare Workers-based temporal
and relational intelligence engine.

This runbook covers the complete deployment lifecycle: prerequisites, first-time
setup, regular deployments, targeted operations, rollback procedures, and
troubleshooting.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [First-Time Setup](#first-time-setup)
3. [Regular Deployment](#regular-deployment)
4. [Targeted Deployment](#targeted-deployment)
5. [Post-Deployment Validation](#post-deployment-validation)

For rollback procedures, see [Rollback](rollback.md).
For troubleshooting, see [Troubleshooting](troubleshooting.md).
For secrets management, see [Secrets](secrets.md).

---

## Prerequisites

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
| `CLOUDFLARE_API_TOKEN` | Wrangler auth (Workers/D1/Queues/DNS edit) | [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID | Dashboard sidebar |
| `TMINUS_ZONE_ID` | Zone ID for `tminus.ink` | Dashboard > tminus.ink > Overview sidebar |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 client ID | [GCP Credentials](https://console.cloud.google.com/apis/credentials) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 client secret | Same as above |
| `MS_CLIENT_ID` | Microsoft Entra ID client ID | [Entra ID](https://entra.microsoft.com/) > App registrations |
| `MS_CLIENT_SECRET` | Microsoft Entra ID client secret | Same as above |
| `JWT_SECRET` | JWT signing/verification secret | Generate: `openssl rand -base64 32` |
| `MASTER_KEY` | Envelope encryption master key | Generate: `openssl rand -base64 32` |

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

## First-Time Setup

These steps are performed once when setting up the project for the first time.

### Create Infrastructure Resources

KV namespaces, R2 buckets, and queues are configured in each worker's `wrangler.toml`. Cloudflare creates these automatically on first `wrangler deploy`. However, if wrangler.toml references specific IDs, create them manually:

```bash
# KV namespaces (if not already created)
npx wrangler kv namespace create "sessions" --env staging
npx wrangler kv namespace create "sessions" --env production

# Update wrangler.toml with the returned namespace IDs
```

### Replace Placeholder IDs

```bash
# Check for remaining placeholders
make check-placeholders
```

### Set Up DNS Records

Production subdomains: `api.tminus.ink`, `app.tminus.ink`, `mcp.tminus.ink`, `webhooks.tminus.ink`, `oauth.tminus.ink`

Staging subdomains: `api-staging.tminus.ink`, `app-staging.tminus.ink`, `mcp-staging.tminus.ink`, `webhooks-staging.tminus.ink`, `oauth-staging.tminus.ink`

```bash
# Production DNS only
make deploy-dns

# Staging DNS only
make dns-setup-staging

# Both environments
make dns-setup-all
```

The DNS setup script (`scripts/dns-setup.mjs`) is idempotent.

### Set Up GCP Project

1. Create a GCP project at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable the Google Calendar API
3. Create OAuth 2.0 credentials (Web application type)
4. Set authorized redirect URIs:
   - `https://oauth.tminus.ink/callback/google` (production)
   - `https://oauth-staging.tminus.ink/callback/google` (staging)
5. Copy Client ID and Client Secret to `.env`

### Deploy Secrets

```bash
make secrets-setup           # Both environments
make secrets-setup-production  # Production only
make secrets-setup-staging     # Staging only
make secrets-setup-dry-run     # Preview
```

### Run D1 Migrations

```bash
make deploy-d1-migrate
```

---

## Regular Deployment

### Full Pipeline (Recommended)

```bash
make deploy
```

This runs `scripts/promote.mjs` which executes the following stages in order:

| # | Stage | Description | Gate |
|---|-------|-------------|------|
| 1 | Build | `pnpm run build` | Build must succeed |
| 2 | Migrate Staging | D1 migrations for staging | Migrations must apply cleanly |
| 3 | Deploy Staging | Deploy all 9 workers to staging | All workers deploy successfully |
| 4 | Health Staging | `GET /health` on all HTTP workers | All return 200 with enriched format |
| 5 | Smoke Staging | Register/login/protected-call flow | All smoke tests pass |
| 6 | Migrate Production | D1 migrations for production | Migrations must apply cleanly |
| 7 | Deploy Production | Deploy all 9 workers to production | All workers deploy successfully |
| 8 | Health Production | `GET /health` on all HTTP workers | All return 200 with enriched format |
| 9 | Smoke Production | Register/login/protected-call flow | All smoke tests pass |

Each stage is a gate: if it fails, subsequent stages do not run.

### Worker Deploy Order

Workers are deployed in dependency order. API must be first because other workers reference its Durable Objects via `script_name`:

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

### HTTP Workers (Health-Checkable)

| Worker | Production URL | Staging URL |
|--------|----------------|-------------|
| api | `https://api.tminus.ink` | `https://api-staging.tminus.ink` |
| oauth | `https://oauth.tminus.ink` | `https://oauth-staging.tminus.ink` |
| webhook | `https://webhooks.tminus.ink` | `https://webhooks-staging.tminus.ink` |
| app-gateway | `https://app.tminus.ink` | `https://app-staging.tminus.ink` |
| mcp | `https://mcp.tminus.ink` | `https://mcp-staging.tminus.ink` |

Workers without HTTP routes (sync-consumer, write-consumer, cron, push) are triggered by queues or cron schedules.

### Dry Run

```bash
make deploy-promote-dry-run
```

---

## Targeted Deployment

### Deploy a Single Worker

```bash
cd workers/<worker-name>
npx wrangler deploy --env production
```

**Warning:** Deploying a single worker bypasses health checks. Always validate afterward:

```bash
make validate-deployment
```

### Deploy Secrets Only

```bash
make secrets-setup              # All secrets to both environments
make secrets-setup-production   # Production only
make secrets-setup-staging      # Staging only
```

### Run D1 Migrations Only

```bash
make deploy-d1-migrate
```

### Deploy DNS Only

```bash
make deploy-dns         # Production
make dns-setup-staging  # Staging
make dns-setup-all      # Both
```

### Staging Only

```bash
make deploy-stage
```

### Production Only (Skip Staging)

```bash
make deploy-prod
```

---

## Post-Deployment Validation

```bash
# Validate all worker health endpoints
make validate-deployment

# Run smoke tests (health + auth enforcement + register/login flow)
make smoke-test
```

The validation script verifies:
1. HTTP 200 response from each health endpoint
2. Enriched JSON format with `ok:true`, `data.status`, `data.environment`, `data.worker`, and `data.bindings`
3. Status is "healthy" or "degraded"
4. Falls back to `--resolve` with Cloudflare anycast IP if DNS hasn't propagated

The smoke test verifies:
1. `GET /health` returns 200 with correct envelope
2. `GET /v1/events` without JWT returns 401 (auth enforcement)
3. `POST /v1/auth/register` creates a user and returns JWT
4. `POST /v1/auth/login` authenticates and returns JWT
5. `GET /v1/events` with JWT returns 200 (protected endpoint access)
