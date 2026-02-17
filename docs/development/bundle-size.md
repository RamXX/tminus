# Bundle Size Analysis

## Background

Cloudflare Workers have a 10 MB compressed bundle size limit (paid plan).
Monitoring bundle size is important because the `@tminus/shared` package is
imported by most workers.

## Measurement

```bash
# Full bundle sizes
node scripts/measure-bundle-sizes.mjs

# Without specific dependency (for comparison)
node scripts/measure-bundle-sizes.mjs --exclude-pattern "zod"

# JSON output for scripting
node scripts/measure-bundle-sizes.mjs --json
```

## Current State (Post-Zod v4-mini Migration)

| Worker | Raw (KB) | Gzip (KB) | Zod Contribution (gzip) |
|--------|----------|-----------|------------------------|
| api | 431.1 | 105.9 | 6.6 KB |
| oauth | 71.8 | 20.6 | 6.6 KB |
| sync-consumer | 54.9 | 17.1 | 6.7 KB |
| write-consumer | 53.0 | 16.3 | 6.6 KB |
| cron | 56.1 | 16.8 | 6.7 KB |
| push | 32.8 | 11.3 | 6.6 KB |
| webhook | 3.0 | 1.1 | 0 KB (no Zod imports) |
| app-gateway | 20.1 | 8.2 | 0 KB (no Zod imports) |

Largest worker (api) uses 105.9 KB of 1,024 KB limit (10.3%).

## Zod v4-Mini Migration

Zod was added as a runtime dependency for schema validation. The classic `zod/v4`
library added ~60 KB gzipped per worker. Migration to `zod/v4-mini` reduced this
to ~6.6 KB per worker (89% reduction).

### API Changes (Classic vs Mini)

| Classic (zod/v4) | Mini (zod/v4-mini) |
|------------------|--------------------|
| `z.string().min(1)` | `z.string().check(z.minLength(1))` |
| `z.string().email()` | `z.email()` |
| `z.string().url()` | `z.url()` |
| `z.string().datetime()` | `z.iso.datetime()` |
| `z.number().int().min(0)` | `z.number().check(z.int(), z.minimum(0))` |
| `schema.optional()` | `z.optional(schema)` |
| `schema.nullable()` | `z.nullable(schema)` |
| `schema.default(val)` | `z._default(schema, val)` |
| `.refine(fn, msg)` | `.check(z.refine(fn, msg))` |
| `import { z } from "zod/v4"` | `import * as z from "zod/v4-mini"` |

`.parse()` and `.safeParse()` work identically. `z.infer<typeof Schema>` type
inference is unchanged.

## Notes

- The `mcp` worker has its own direct `import { z } from "zod"` separate from
  the shared package, pulling in the full Zod classic library (~60 KB gzipped).
  This may be addressed separately if MCP bundle size becomes a concern.
