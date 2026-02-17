# Project Structure

T-Minus is organized as a pnpm monorepo.

```
tminus/
  packages/
    shared/                  # Shared types, schemas, constants
      src/
        types.ts             # Canonical event types, policy types, message shapes
        schema.ts            # DO SQLite schema definitions
        constants.ts         # Service name, extended property keys
        policy.ts            # Policy compiler (detail_level -> projected payload)
        hash.ts              # Stable hashing for projection comparison
    d1-registry/             # D1 migration files

  workers/
    api/                     # Public API (unified calendar, availability, policies)
      src/
        index.ts
        routes/
          events.ts          # CRUD canonical events
          availability.ts    # Unified free/busy across accounts
          policies.ts        # Policy CRUD
          accounts.ts        # Account management
          scheduling.ts      # Scheduling session management

    oauth/                   # OAuth flow handler
      src/
        index.ts             # /oauth/google/start, /oauth/google/callback

    webhook/                 # Google Calendar push notification receiver
      src/
        index.ts             # Validate headers, enqueue SYNC_INCREMENTAL

    sync-consumer/           # Queue consumer: provider -> canonical
      src/
        index.ts             # Pull incremental updates, call UserGraphDO

    write-consumer/          # Queue consumer: canonical -> provider
      src/
        index.ts             # Execute Calendar API writes with idempotency

    mcp/                     # MCP server endpoint (Phase 2)
      src/
        index.ts

    cron/                    # Scheduled maintenance
      src/
        index.ts             # Channel renewal, token refresh, drift reconciliation

    app-gateway/             # Web app gateway (SPA serving + proxy)

    push/                    # Push notification worker

  durable-objects/
    user-graph/              # UserGraphDO: per-user canonical state + coordination
      src/
        index.ts
        schema.sql           # DO SQLite schema
        sync.ts              # applyProviderDelta()
        projection.ts        # recomputeProjections()
        availability.ts      # computeAvailability()

    account/                 # AccountDO: per-external-account token + sync state
      src/
        index.ts
        token.ts             # Token encryption/refresh
        channel.ts           # Watch channel lifecycle

    group-schedule/          # GroupScheduleDO: multi-user scheduling (Phase 3+)
      src/
        index.ts

  workflows/
    onboarding/              # OnboardingWorkflow: initial full sync
      src/
        index.ts

    reconcile/               # ReconcileWorkflow: drift repair
      src/
        index.ts

    scheduling/              # SchedulingWorkflow (Phase 3+)
      src/
        index.ts

    deletion/                # DeletionWorkflow: GDPR deletion cascade
      src/
        index.ts

  migrations/
    d1-registry/             # D1 SQL migration files

  scripts/                   # Deployment and utility scripts
    promote.mjs              # Stage-to-production pipeline
    dns-setup.mjs            # DNS record management
    setup-secrets.mjs        # Secrets deployment
    smoke-test.mjs           # API smoke tests
    validate-deployment.sh   # Worker health validation
    measure-bundle-sizes.mjs # Bundle size measurement

  docs/                      # Project documentation (you are here)
```

## Key Conventions

- **Each worker** has its own `wrangler.toml` with bindings for its specific environment
- **Shared code** lives in `packages/shared/` and is imported by workers
- **Durable Objects** are hosted on the `tminus-api` worker; other workers reference them via `script_name`
- **Workflows** are hosted on their respective workers (OnboardingWorkflow on oauth, ReconcileWorkflow on cron)
- **Tests** live alongside the code they test, or in dedicated test directories
