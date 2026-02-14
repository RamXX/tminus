# Architecture Learnings

## Web Crypto API for Workers Crypto (from TM-cd1)
**Priority:** Useful
**Source:** TM-cd1 retro

Use Web Crypto API (crypto.subtle) for all cryptographic operations in Workers:
- JWT HS256 signing/verification
- SHA-256 hashing (for projected_hash, idempotency keys)
- No external libraries needed (no jose, no jsonwebtoken)

Benefits: Smaller bundle, no supply chain risk, native runtime support.

## Envelope-First API Design (from TM-cd1)
**Priority:** Useful
**Source:** TM-cd1 retro

All API responses use consistent envelope:
```json
{
  "ok": true/false,
  "data": { ... },
  "error": { "code": "NOT_FOUND", "message": "..." },
  "meta": { "request_id": "...", "timestamp": "..." }
}
```

Error taxonomy: AUTH_REQUIRED, FORBIDDEN, NOT_FOUND, CONFLICT, VALIDATION_ERROR.

Benefits: Simplifies client SDK generation, consistent error handling.

## DO Communication Pattern (from TM-cd1)
**Priority:** Useful
**Source:** TM-cd1 retro

Durable Object interaction via stub.fetch() with JSON body:
```typescript
const stub = env.USER_GRAPH_DO.get(doId);
const response = await stub.fetch('http://do/rpc', {
  method: 'POST',
  body: JSON.stringify({ action: 'applyProviderDelta', payload: { ... } })
});
```

DO routes internally based on action field. Clean, testable, consistent.
