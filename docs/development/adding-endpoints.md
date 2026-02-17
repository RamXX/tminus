# Adding Endpoints

How to add new REST API endpoints to the T-Minus api-worker.

## Steps

1. **Create or update the route file:**

Routes live in `workers/api/src/routes/`. Each route file groups related endpoints.

```typescript
// workers/api/src/routes/my-feature.ts
import { Hono } from 'hono';

const app = new Hono<{ Bindings: Env }>();

app.get('/v1/my-feature', async (c) => {
  // Implementation
  return c.json({
    ok: true,
    data: { /* ... */ },
    meta: {
      request_id: c.get('requestId'),
      timestamp: new Date().toISOString()
    }
  });
});

export default app;
```

2. **Register the route in the main index:**

```typescript
// workers/api/src/index.ts
import myFeature from './routes/my-feature';

app.route('/', myFeature);
```

3. **Follow the response envelope:**

All responses use the [standard envelope](../api/envelope.md):

```json
{
  "ok": true,
  "data": { ... },
  "meta": { "request_id": "...", "timestamp": "..." }
}
```

4. **Add error handling:**

Use structured error codes from the [error taxonomy](../api/error-codes.md).

5. **Add tests:**

- Unit tests for business logic
- Integration tests for the full request/response cycle

## Conventions

- Use cursor-based pagination (not offset-based)
- Use ISO 8601 timestamps in UTC
- Use ULID-prefixed IDs (`evt_`, `acc_`, `pol_`, etc.)
- All endpoints require authentication (bearer token)
- Include `request_id` in all responses for correlation
