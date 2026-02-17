# Rollback Procedures

## Worker Rollback

Cloudflare Workers support instant rollback to the previous deployment version:

```bash
# Rollback a specific worker
npx wrangler rollback --name tminus-api --env production

# Rollback multiple workers (reverse deploy order for safety)
for worker in push mcp app-gateway cron webhook oauth write-consumer sync-consumer api; do
  echo "Rolling back tminus-${worker}..."
  npx wrangler rollback --name "tminus-${worker}" --env production
done
```

### When to Rollback vs Fix-Forward

| Situation | Action |
|-----------|--------|
| Health checks fail after deploy | Rollback immediately |
| Smoke tests fail (auth broken) | Rollback immediately |
| Error rate spike in production | Rollback, then investigate |
| Minor bug found in new feature | Fix-forward (new deploy) |
| Data corruption risk | Rollback immediately |

After rolling back, always validate:

```bash
make validate-deployment
make smoke-test
```

---

## D1 Migration Rollback

D1 migrations are **forward-only**. There is no `wrangler d1 migrations rollback` command.

To reverse a D1 migration:

1. **Write a compensating migration** that undoes the changes:

```sql
-- migrations/d1-registry/NNNN_rollback_description.sql
-- Reverse migration NNNN: <describe what this reverses>

-- If the migration added a column:
ALTER TABLE table_name DROP COLUMN column_name;

-- If the migration created a table:
DROP TABLE IF EXISTS table_name;

-- If the migration added an index:
DROP INDEX IF EXISTS index_name;
```

2. **Apply the compensating migration:**

```bash
make deploy-d1-migrate
```

3. **Test the rollback** on staging first:

```bash
source .env && npx wrangler d1 migrations apply tminus-registry-staging --remote --env staging --config wrangler-d1.toml
```

**Warning:** SQLite (D1) does not support all `ALTER TABLE` operations. Dropping columns requires SQLite 3.35.0+. If a column drop is not supported, the compensating migration may need to recreate the table.

---

## Secret Rotation

If a secret is compromised:

1. **Generate new values:**

```bash
openssl rand -base64 32
```

2. **Update `.env`** with the new value.

3. **Deploy new secrets:**

```bash
make secrets-setup-production
```

4. **Redeploy affected workers:**

```bash
cd workers/api && npx wrangler deploy --env production
cd workers/oauth && npx wrangler deploy --env production
```

5. **For OAuth credentials** (Google/Microsoft): Also update the credentials in the respective provider console.

### Rotation Warnings

- Rotating `JWT_SECRET` invalidates all existing JWTs. Users will need to re-authenticate.
- Rotating `MASTER_KEY` will make existing encrypted OAuth tokens unreadable -- a key migration strategy is needed (decrypt with old key, re-encrypt with new key).
