# T-Minus

A Cloudflare-native temporal and relational intelligence engine that federates
multiple Google Calendar accounts into a single canonical event store.

- **Calendar federation** -- Connect 2+ Google accounts; events sync bidirectionally via busy overlay calendars.
- **Policy-driven projection** -- Control what each account sees (busy-only, title, or full detail) per direction.
- **Scheduling intelligence** -- Constraint-based scheduling, commitment tracking, and relationship awareness (Phase 3+).
- **AI-native control** -- MCP server lets AI assistants manage your calendar programmatically (Phase 2+).

## Quick Start

```bash
# Prerequisites: Node.js 18+, pnpm 8+
pnpm install
pnpm run build

# Run tests
make test-unit
make test-integration

# Deploy (requires .env -- see docs/operations/deployment.md)
cp .env.example .env   # fill in real values
make deploy
```

## Architecture at a Glance

```
                +------------------+
                |   Google APIs    |
                | (Calendar, OAuth)|
                +--------+---------+
                         |
          webhook push   |   OAuth + API calls
                         |
+------------------------+------------------------+
|                        |                        |
v                        v                        v
+-----------+    +-----------+            +-----------+
| webhook   |    | oauth     |            | cron      |
| worker    |    | worker    |            | worker    |
+-----------+    +-----------+            +-----------+
    |                |                        |
    | enqueue        | create account         | channel renewal
    | SYNC_INCR.     | + onboarding           | token refresh
    v                v                        | reconciliation
+-----------+  +-------------+                v
| sync-queue|  | D1 Registry |        +--------------+
+-----------+  +-------------+        |reconcile-queue|
    |                                 +--------------+
    v
+-----------+
| sync      |-------> +----------------+
| consumer  |         | AccountDO      | (per account)
+-----------+         +----------------+
    |
    | applyDelta
    v
+----------------+
| UserGraphDO    | (per user)
| - canonical    |
|   events       |
| - mirrors      |
| - journal      |
| - policies     |
+-------+--------+
        |
        | enqueue UPSERT_MIRROR
        v
+------------+     +-----------+
| write-queue|---->| write     |------> Google Calendar API
+------------+     | consumer  |        (mirrors)
                   +-----------+

+-----------+                    +-----------+
| api       |<--- UI / MCP ---->| mcp       |
| worker    |                   | worker    |
+-----------+                   +-----------+
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Cloudflare Workers (V8 isolates) |
| Per-user storage | Durable Objects with SQLite |
| Cross-user registry | Cloudflare D1 |
| Async pipelines | Cloudflare Queues (sync, write, reconcile) |
| Orchestration | Cloudflare Workflows |
| Audit storage | Cloudflare R2 |
| Language | TypeScript (ES2022) |
| Monorepo | pnpm workspaces |

## Project Structure

```
workers/              # Stateless edge workers
  api/                #   Public REST API
  oauth/              #   OAuth flow handler
  webhook/            #   Google Calendar push receiver
  sync-consumer/      #   Queue consumer: provider -> canonical
  write-consumer/     #   Queue consumer: canonical -> provider
  cron/               #   Scheduled maintenance
  mcp/                #   MCP server (Phase 2)
  app-gateway/        #   Web app gateway
  push/               #   Push notifications
durable-objects/      # Stateful coordinators
  user-graph/         #   UserGraphDO: per-user canonical state
  account/            #   AccountDO: per-account token + sync
  group-schedule/     #   GroupScheduleDO (Phase 3+)
workflows/            # Long-running orchestration
  onboarding/         #   Initial full sync
  reconcile/          #   Daily drift repair
  scheduling/         #   Scheduling workflow (Phase 3+)
  deletion/           #   GDPR deletion workflow
packages/
  shared/             # Shared types, schemas, constants
  d1-registry/        # D1 migrations
```

## Documentation

Full documentation lives in [`docs/`](docs/index.md):

- [Architecture](docs/architecture/overview.md) -- System design, data model, flows
- [API Reference](docs/api/reference.md) -- REST endpoints, contracts, error codes
- [Operations](docs/operations/deployment.md) -- Deployment, secrets, monitoring
- [Development](docs/development/getting-started.md) -- Setup, testing, conventions
- [Decisions](docs/decisions/) -- Architecture Decision Records (ADR-001 through ADR-007)
- [Security](docs/security/overview.md) -- Encryption, privacy, CASA assessment
- [Business](docs/business/vision.md) -- Vision, roadmap, personas

## License

Proprietary. All rights reserved.
