.PHONY: build test test-unit test-integration test-integration-real test-e2e test-scripts lint deploy deploy-secrets deploy-d1-migrate deploy-production deploy-staging deploy-production-dry-run deploy-dns smoke-test install clean typecheck

# ---- Core targets ----

install:
	pnpm install

build: install
	pnpm run build

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

deploy: build
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

smoke-test:
	@test -f .env || { echo "ERROR: .env not found. Copy .env.example and fill in values."; exit 1; }
	node scripts/smoke-test.mjs --env production

smoke-test-staging:
	node scripts/smoke-test.mjs --env staging
