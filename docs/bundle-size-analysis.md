# Bundle Size Analysis: Zod Runtime Dependency (TM-8z5v)

Date: 2026-02-15

## Summary

Zod was added as a runtime dependency to `@tminus/shared` for delegation and
discovery schema validation (TM-9iu.2, TM-9iu.3). This analysis quantifies
the bundle size impact and documents the mitigation applied.

## Findings

### Before mitigation (zod/v4 classic)

| Worker         | Raw (KB) | Gzip (KB) | Zod Contribution (gzip) |
|----------------|----------|-----------|------------------------|
| api            | 713.2    | 159.7     | 60.4 KB                |
| oauth          | 353.8    | 74.2      | 60.2 KB                |
| sync-consumer  | 336.9    | 70.9      | 60.5 KB                |
| write-consumer | 335.0    | 70.1      | 60.4 KB                |
| mcp            | 382.3    | 80.3      | 60.1 KB                |
| cron           | 338.1    | 70.4      | 60.3 KB                |
| push           | 314.8    | 64.9      | 60.2 KB                |
| webhook        | 3.0      | 1.1       | 0 KB (no Zod imports)  |
| app-gateway    | 20.1     | 8.2       | 0 KB (no Zod imports)  |

`zod/v4` (classic) added approximately **60 KB gzipped** to every worker
that imports from `@tminus/shared`. This exceeds the 50 KB threshold.

### After mitigation (zod/v4-mini)

| Worker         | Raw (KB) | Gzip (KB) | Zod Contribution (gzip) |
|----------------|----------|-----------|------------------------|
| api            | 431.1    | 105.9     | 6.6 KB                 |
| oauth          | 71.8     | 20.6      | 6.6 KB                 |
| sync-consumer  | 54.9     | 17.1      | 6.7 KB                 |
| write-consumer | 53.0     | 16.3      | 6.6 KB                 |
| cron           | 56.1     | 16.8      | 6.7 KB                 |
| push           | 32.8     | 11.3      | 6.6 KB                 |
| webhook        | 3.0      | 1.1       | 0 KB                   |
| app-gateway    | 20.1     | 8.2       | 0 KB                   |

After migrating to `zod/v4-mini`, the Zod contribution dropped to approximately
**6.6 KB gzipped** per worker -- well under the 50 KB threshold.

### Savings

- **Per worker savings**: ~53.8 KB gzipped (from 60.4 to 6.6 KB)
- **Reduction**: 89% smaller Zod footprint
- **Cloudflare limit headroom**: Largest worker (api) uses 105.9 KB of 1,024 KB limit (10.3%)

## Mitigation Applied

Migrated from `zod/v4` (classic API) to `zod/v4-mini` in:

- `packages/shared/src/delegation-schemas.ts`
- `packages/shared/src/discovery-schemas.ts`

### API Changes

The mini variant uses a functional `.check()` API instead of chained methods:

| Classic (zod/v4)              | Mini (zod/v4-mini)                        |
|-------------------------------|-------------------------------------------|
| `z.string().min(1)`           | `z.string().check(z.minLength(1))`        |
| `z.string().email()`          | `z.email()`                               |
| `z.string().url()`            | `z.url()`                                 |
| `z.string().datetime()`       | `z.iso.datetime()`                        |
| `z.number().int().min(0)`     | `z.number().check(z.int(), z.minimum(0))` |
| `schema.optional()`           | `z.optional(schema)`                      |
| `schema.nullable()`           | `z.nullable(schema)`                      |
| `schema.default(val)`         | `z._default(schema, val)`                 |
| `.refine(fn, msg)`            | `.check(z.refine(fn, msg))`               |
| `import { z } from "zod/v4"` | `import * as z from "zod/v4-mini"`        |

`.parse()` and `.safeParse()` methods on schema objects work identically.
`z.infer<typeof Schema>` type inference is unchanged.

## Additional Observations

- The `mcp` worker has its own direct `import { z } from "zod"` in
  `workers/mcp/src/index.ts` (line 13), separate from the shared package.
  This pulls in the full Zod classic library (~60 KB gzipped) independently.
  A separate story should address this if MCP bundle size becomes a concern.

## Measurement Tool

`scripts/measure-bundle-sizes.mjs` was added for repeatable bundle size
measurement. Usage:

```bash
# Full bundle sizes
node scripts/measure-bundle-sizes.mjs

# Without specific dependency (for comparison)
node scripts/measure-bundle-sizes.mjs --exclude-pattern "zod"

# JSON output for scripting
node scripts/measure-bundle-sizes.mjs --json
```

## Decision

Zod v4-mini at ~6.6 KB gzipped is acceptable for runtime schema validation.
The benefit of catching schema evolution bugs at deserialization time outweighs
the minimal bundle size cost.
