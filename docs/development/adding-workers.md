# Adding Workers

How to add a new Worker service to the T-Minus monorepo.

## Steps

1. **Create the worker directory:**

```bash
mkdir -p workers/<worker-name>/src
```

2. **Create `wrangler.toml`:**

```toml
name = "tminus-<worker-name>"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[env.staging]
name = "tminus-<worker-name>-staging"
# Add all bindings here

[env.production]
name = "tminus-<worker-name>-production"
# Add all bindings here -- NO inheritance from top-level
```

3. **Create `src/index.ts`:**

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handler logic
  }
} satisfies ExportedHandler<Env>;
```

4. **Create `package.json`:**

```json
{
  "name": "tminus-<worker-name>",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@tminus/shared": "workspace:*"
  }
}
```

5. **Add to the deploy pipeline:**

Update `scripts/promote.mjs` to include the new worker in the deploy order.

6. **Add Durable Object bindings** (if needed):

Reference DOs hosted on tminus-api using `script_name`:

```toml
[[env.production.durable_objects.bindings]]
name = "USER_GRAPH"
class_name = "UserGraph"
script_name = "tminus-api-production"
```

7. **Register in DNS** (if the worker has HTTP routes):

Update `scripts/dns-setup.mjs` with the new subdomain.

## Checklist

- [ ] Worker directory created with `wrangler.toml`, `src/index.ts`, `package.json`
- [ ] Added to `scripts/promote.mjs` deploy order
- [ ] All bindings declared in `[env.staging]` and `[env.production]` sections
- [ ] `compatibility_flags = ["nodejs_compat"]` present
- [ ] DNS record configured (if HTTP-facing)
- [ ] Health endpoint implemented (if HTTP-facing)
- [ ] Added to `scripts/validate-deployment.sh` (if HTTP-facing)
