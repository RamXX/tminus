.PHONY: build test test-unit test-integration lint deploy install clean typecheck

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

lint: install
	pnpm run lint

typecheck: install
	pnpm run typecheck

deploy: build
	pnpm run deploy

clean:
	pnpm -r exec rm -rf dist
	pnpm -r exec rm -rf .wrangler
	rm -rf node_modules
