.PHONY: build test test-unit test-integration test-scripts lint deploy deploy-secrets deploy-d1-migrate install clean typecheck

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
	pnpm run test:integration

test-scripts: install
	npx vitest run --config scripts/vitest.config.mjs

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
