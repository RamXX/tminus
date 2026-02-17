# Troubleshooting

## Error 1101: Worker threw a JavaScript exception

**Symptoms:** HTTP 1101 error from Cloudflare edge.

**Common causes:**
- Missing `nodejs_compat` compatibility flag in `wrangler.toml` (required for `ulid` package)
- Named exports in `index.ts` beyond the default handler and DO classes (workerd rejects these)
- Accessing an undefined binding (D1, KV, queue not configured in the environment section)

**Fix:**
1. Check `compatibility_flags = ["nodejs_compat"]` is present in the worker's `wrangler.toml` under the correct `[env.production]` section
2. Verify `index.ts` only exports the default handler and DO classes -- move constants/utilities to separate modules
3. Verify all bindings are fully declared in the `[env.production]` section (wrangler environments have NO inheritance from the top-level config)

---

## Durable Object Binding Errors

**Symptoms:** "Durable Object namespace ... is not defined" or "Cannot find script ..."

**Common causes:**
- API worker not deployed before consumers/oauth/cron
- `script_name` in wrangler.toml using base name instead of env-suffixed name

**Fix:**
1. Verify API worker is deployed first: `npx wrangler deployments list --name tminus-api --env production`
2. Check `script_name` in dependent workers' `wrangler.toml` uses `tminus-api-production` (not `tminus-api`) for the production environment section

---

## DNS Propagation Delays

**Symptoms:** `curl https://api.tminus.ink/health` returns connection refused or DNS resolution failure.

**Timeline:** DNS changes propagate within seconds for proxied Cloudflare records, but can take up to 5 minutes in edge cases.

**Fix:**
1. Verify DNS records exist: `dig api.tminus.ink +short` (should return Cloudflare IPs)
2. Use `--resolve` to bypass DNS cache: `curl --resolve "api.tminus.ink:443:104.18.0.0" https://api.tminus.ink/health`
3. Re-run DNS setup if records are missing: `make deploy-dns`

---

## Health Check Returns Non-Enriched Format

**Symptoms:** `validate-deployment.sh` reports `FAIL (format=legacy-json, expected enriched)`.

**Cause:** Worker is running an old version without the enriched health response.

**Fix:** Redeploy the worker:

```bash
cd workers/<worker-name> && npx wrangler deploy --env production
```

---

## Smoke Test Auth Flow Fails

**Symptoms:** `smoke-test.mjs` fails on register or login steps.

**Common causes:**
- D1 migrations not applied (users table missing)
- `JWT_SECRET` not set as a worker secret
- Incorrect D1 binding in production wrangler.toml

**Fix:**
1. Apply D1 migrations: `make deploy-d1-migrate`
2. Deploy secrets: `make secrets-setup-production`
3. Verify D1 binding in `workers/api/wrangler.toml` under `[env.production]`

---

## Quick Reference: Make Targets

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
