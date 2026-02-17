# Coding Conventions

## Language and Runtime

- **TypeScript** for all Workers, Durable Objects, and Workflows
- **Cloudflare Workers runtime** (V8 isolates) -- No Node.js APIs unless polyfilled
- Target **ES2022** for modern language features
- Run linting: `make lint`
- Run type checking: `make typecheck`

## ID Generation

- **ULID** for all primary keys: `canonical_event_id`, `journal_id`, `policy_id`, etc.
- ULIDs are time-ordered (benefits index performance, provides implicit creation timestamps)
- Prefixed by entity type for readability: `usr_`, `acc_`, `evt_`, `pol_`, `cal_`, `jrn_`
- **UUIDs (v4)** for watch channel IDs (Google convention)

## Schema Migrations

- **DO SQLite:** Schemas applied on first access after deployment. Each DO maintains `schema_version` and runs migrations forward on wake-up.
- **D1:** Standard SQL migration files in `migrations/d1-registry/`, applied via `wrangler d1 migrations apply`.

## Error Handling

- Errors use structured codes (see [Error Codes](../api/error-codes.md))
- Every error response includes `request_id` for correlation
- Provider errors include upstream error detail when safe to expose
- Dead Letter Queues for persistent queue failures
- `event_mirrors.state = 'ERROR'` with `error_message` for persistent write failures

## Queue Message Design

- All messages include `trace_id`, `enqueued_at`, `attempt`
- Stay under 128 KB queue message limit
- Include `idempotency_key` for write operations

## Timestamp Format

- ISO 8601, always UTC in wire format
- Timezone context carried as a separate field where relevant

## Pagination

- Cursor-based (not offset-based)
- Cursor is an opaque token encoding the last-seen ULID

## Wrangler Configuration

- Each worker has its own `wrangler.toml`
- Environment sections have NO inheritance from top-level config -- declare all bindings in each `[env.*]` section
- Only export the default handler and DO classes from `index.ts` -- move constants/utilities to separate modules
