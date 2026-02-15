.PHONY: build build-web test test-unit test-integration test-integration-real test-e2e test-e2e-phase2a test-e2e-phase2a-staging test-e2e-phase2a-production test-e2e-phase2b test-e2e-phase2b-staging test-e2e-phase2b-production test-scripts lint deploy deploy-promote deploy-stage deploy-prod deploy-promote-dry-run deploy-secrets deploy-d1-migrate deploy-production deploy-staging deploy-production-dry-run deploy-dns dns-setup dns-setup-staging dns-setup-all smoke-test secrets-setup secrets-setup-staging secrets-setup-production secrets-setup-dry-run install clean typecheck

# ---- Core targets ----

install:
	pnpm install

build: install
	pnpm run build

build-web: install
	pnpm run build:web

test: install
	pnpm run test

test-unit: install
	pnpm run test:unit

test-integration: install
	npx vitest run --config vitest.integration.config.ts

test-scripts: install
	npx vitest run --config scripts/vitest.config.mjs

test-integration-real: install
	@test -f .env && . ./.env; npx vitest run --config vitest.integration.real.config.ts

test-e2e: install
	@test -f .env && . ./.env; npx vitest run --config vitest.e2e.config.ts

# ---- Phase 2A E2E validation ----
# Real HTTP tests against a running API worker.
# Default target runs against localhost:8787 (start wrangler dev first).

test-e2e-phase2a: install
	BASE_URL=http://localhost:8787 npx vitest run --config vitest.e2e.phase2a.config.ts

test-e2e-phase2a-staging: install
	BASE_URL=https://api-staging.tminus.ink npx vitest run --config vitest.e2e.phase2a.config.ts

test-e2e-phase2a-production: install
	BASE_URL=https://api.tminus.ink npx vitest run --config vitest.e2e.phase2a.config.ts

# ---- Phase 2B E2E validation ----
# Real HTTP tests against a running MCP worker.
# Default target runs against localhost:8976 (start MCP wrangler dev first).
# Setup: ./scripts/e2e-mcp-setup.sh

test-e2e-phase2b: install
	MCP_BASE_URL=http://localhost:8976 npx vitest run --config vitest.e2e.phase2b.config.ts

test-e2e-phase2b-staging: install
	MCP_BASE_URL=https://mcp-staging.tminus.ink npx vitest run --config vitest.e2e.phase2b.config.ts

test-e2e-phase2b-production: install
	MCP_BASE_URL=https://mcp.tminus.ink npx vitest run --config vitest.e2e.phase2b.config.ts

lint: install
	pnpm run lint

typecheck: install
	pnpm run typecheck

clean:
	pnpm -r exec rm -rf dist
	pnpm -r exec rm -rf .wrangler
	rm -rf node_modules

# ---- Deployment targets ----
# All deploy targets source .env for Cloudflare credentials.
# Run `cp .env.example .env` and fill in values before deploying.

# Full stage-to-prod pipeline: build -> staging (deploy+health+smoke) -> production
deploy: build
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	. ./.env && node scripts/promote.mjs --skip-build

# Stage-only: deploy all workers to staging, verify health, run smoke tests
deploy-stage: build
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	. ./.env && node scripts/promote.mjs --stage-only --skip-build

# Production-only: deploy all workers to production (assumes staging already verified)
deploy-prod: build
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	. ./.env && node scripts/promote.mjs --prod-only --skip-build

# Alias for full pipeline
deploy-promote: deploy

deploy-promote-dry-run:
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	. ./.env && node scripts/promote.mjs --dry-run

# Legacy single-service deploy (deploy.mjs -- creates D1/queues/workers without env separation)
deploy-legacy:
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	. ./.env && node scripts/deploy.mjs

deploy-dry-run:
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	. ./.env && node scripts/deploy.mjs --dry-run

deploy-secrets:
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	. ./.env && node scripts/deploy-secrets.mjs

deploy-d1-migrate:
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	. ./.env && npx wrangler d1 migrations apply tminus-registry --remote --config wrangler-d1.toml

# ---- Production deployment targets ----
# Deploy api-worker to api.tminus.ink with DNS, secrets, and smoke tests.

deploy-production: build
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	. ./.env && node scripts/deploy-production.mjs --env production

deploy-staging: build
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	. ./.env && node scripts/deploy-production.mjs --env staging

deploy-production-dry-run:
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	. ./.env && node scripts/deploy-production.mjs --env production --dry-run

deploy-dns:
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	. ./.env && node scripts/dns-setup.mjs --env production

dns-setup:
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	. ./.env && node scripts/dns-setup.mjs --env all

dns-setup-staging:
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	. ./.env && node scripts/dns-setup.mjs --env staging

dns-setup-all:
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	. ./.env && node scripts/dns-setup.mjs --env all

smoke-test:
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	node scripts/smoke-test.mjs --env production

smoke-test-staging:
	node scripts/smoke-test.mjs --env staging

# ---- Secrets management ----
# Dedicated secrets setup for all workers across environments.
# See SECRETS.md for full documentation.

secrets-setup:
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	. ./.env && node scripts/setup-secrets.mjs

secrets-setup-staging:
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	. ./.env && node scripts/setup-secrets.mjs --env staging

secrets-setup-production:
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	. ./.env && node scripts/setup-secrets.mjs --env production

secrets-setup-dry-run:
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	. ./.env && node scripts/setup-secrets.mjs --dry-run
