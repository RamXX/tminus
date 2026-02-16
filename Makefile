.PHONY: build build-web test test-unit test-integration test-integration-real test-e2e test-e2e-phase2a test-e2e-phase2a-staging test-e2e-phase2a-production test-e2e-phase2b test-e2e-phase2b-staging test-e2e-phase2b-production test-e2e-phase3a test-e2e-phase4b test-e2e-phase4c test-e2e-phase4d test-e2e-phase5a test-e2e-phase5b test-e2e-phase6a test-e2e-phase6b test-e2e-phase6c test-scripts lint deploy deploy-promote deploy-stage deploy-prod deploy-promote-dry-run deploy-secrets deploy-d1-migrate deploy-production deploy-staging deploy-production-dry-run deploy-dns dns-setup dns-setup-staging dns-setup-all smoke-test secrets-setup secrets-setup-staging secrets-setup-production secrets-setup-dry-run install clean typecheck check-placeholders ios-build ios-test ios-clean

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

# ---- Phase 3A E2E validation ----
# Scheduling engine E2E tests: propose times, commit candidates, verify events.
# Uses real SQLite + real UserGraphDO + real SchedulingWorkflow (no HTTP server).

test-e2e-phase3a: install
	npx vitest run --config vitest.e2e.phase3a.config.ts

# ---- Phase 4B E2E validation ----
# Geo-aware intelligence pipeline: relationships + trips + reconnections + milestones.
# Uses real SQLite + real UserGraphDO + real SchedulingWorkflow (no HTTP server).

test-e2e-phase4b: install
	npx vitest run --config vitest.e2e.phase4b.config.ts

# ---- Phase 4C E2E validation ----
# Context and communication pipeline: briefing + excuse generation + commitment proof.
# Uses real SQLite + real UserGraphDO + real pure functions (no HTTP server).

test-e2e-phase4c: install
	npx vitest run --config vitest.e2e.phase4c.config.ts

# ---- Phase 4D E2E validation ----
# Advanced scheduling pipeline: multi-user group scheduling, fairness scoring,
# hold lifecycle (create/extend/expire), external solver fallback.
# Uses real SQLite + real UserGraphDO + real GroupScheduleDO + real SchedulingWorkflow.

test-e2e-phase4d: install
	npx vitest run --config vitest.e2e.phase4d.config.ts

# ---- Phase 5A E2E validation ----
# Platform extensions: CalDAV feed, org policy merge, what-if simulation,
# temporal graph API (relationships, reputation, timeline).
# Uses real SQLite + real UserGraphDO + real pure functions (no HTTP server).

test-e2e-phase5a: install
	npx vitest run --config vitest.e2e.phase5a.config.ts

# ---- Phase 5B E2E validation ----
# Advanced intelligence pipeline: cognitive load scoring, context switch costs,
# deep work protection, temporal risk scoring, probabilistic availability.
# Uses real SQLite + real UserGraphDO + real pure functions (no HTTP server).

test-e2e-phase5b: install
	npx vitest run --config vitest.e2e.phase5b.config.ts

# ---- Phase 6A E2E validation ----
# Multi-provider onboarding journey: full 3-provider flow, 5-account stress,
# session resilience, error recovery, account management.
# Uses real API handler + stateful DO stub AND real UserGraphDO + real SQLite.

test-e2e-phase6a: install
	npx vitest run --config vitest.e2e.phase6a.config.ts

# ---- Phase 6B E2E validation ----
# Google Workspace Marketplace lifecycle E2E tests: individual install,
# org install, uninstall flows, re-install, and edge cases.
# Uses real OAuth worker handler chain with injectable fetch.

test-e2e-phase6b: install
	npx vitest run --config vitest.e2e.phase6b.config.ts

# ---- Phase 6C E2E validation ----
# Progressive onboarding journey: zero-auth ICS import, feed refresh,
# upgrade prompts, OAuth upgrade flow, mixed view, downgrade resilience.
# Uses real API handler + real D1 (better-sqlite3) + mock DO stubs.

test-e2e-phase6c: install
	npx vitest run --config vitest.e2e.phase6c.config.ts

# ---- Phase 6D E2E validation ----
# Domain-wide delegation lifecycle: admin registration, user discovery,
# calendar federation, admin dashboard, rate limiting, compliance audit,
# delegation revocation detection, key rotation.
# Uses real API handlers + real D1 (better-sqlite3) + mock Google APIs.

test-e2e-phase6d: install
	npx vitest run --config vitest.e2e.phase6d.config.ts

lint: install
	pnpm run lint

typecheck: install
	pnpm run typecheck

clean:
	pnpm -r exec rm -rf dist
	pnpm -r exec rm -rf .wrangler
	rm -rf node_modules

# ---- Validation targets ----

check-placeholders:
	@if grep -rn 'placeholder\|PLACEHOLDER' workers/*/wrangler.toml 2>/dev/null; then \
		echo "ERROR: Placeholder IDs found in wrangler.toml files. Replace them with real resource IDs before deploying."; \
		exit 1; \
	else \
		echo "OK: No placeholder IDs found in any wrangler.toml."; \
	fi

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

# ---- iOS targets ----
# Build and test the iOS walking skeleton (Swift Package Manager).
# Requires Xcode 16+ with Swift 6.1+ toolchain.

ios-build:
	cd ios/TMinus && swift build

ios-test:
	cd ios/TMinus && swift test

ios-clean:
	cd ios/TMinus && swift package clean
