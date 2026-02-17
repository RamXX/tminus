# Getting Started

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 18+ | `brew install node` or `nvm use 18` |
| pnpm | 8+ | `npm install -g pnpm` |
| wrangler | 3+ | Installed via `pnpm install` (project devDep) |

## Setup

```bash
# 1. Clone the repository
git clone <repo-url>
cd tminus

# 2. Install dependencies
make install
# or: pnpm install

# 3. Build all packages
make build
# or: pnpm run build

# 4. Run unit tests
make test-unit

# 5. Run integration tests
make test-integration
```

## Environment Configuration

For local development, copy the example environment file:

```bash
cp .env.example .env
```

See [Secrets Management](../operations/secrets.md) for the full list of required variables.

## Running Locally

Individual workers can be started locally using wrangler dev:

```bash
cd workers/api
npx wrangler dev

# In another terminal
cd workers/oauth
npx wrangler dev
```

## Key Make Targets

| Target | Description |
|--------|-------------|
| `make install` | Install pnpm dependencies |
| `make build` | Build all packages |
| `make test` | Run all tests |
| `make test-unit` | Run unit tests only |
| `make test-integration` | Run integration tests |
| `make lint` | Run linter |
| `make typecheck` | Run TypeScript type checking |
| `make clean` | Remove build artifacts and node_modules |

## Next Steps

- [Project Structure](project-structure.md) -- Understand the monorepo layout
- [Testing Guide](testing.md) -- Learn the testing patterns
- [Coding Conventions](coding-conventions.md) -- Follow the coding standards
