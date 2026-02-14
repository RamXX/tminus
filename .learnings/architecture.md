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

---

## [Added from Epic TM-852 retro - 2026-02-14]

### Design for extension from the start

**Priority:** Important

**Context:** TM-swj added Microsoft provider support smoothly because CalendarProvider interface and D1 provider column already existed. No refactoring required.

**Recommendation:** When designing interfaces for external integrations (APIs, providers, services):
1. Define provider-agnostic interface even if only one implementation exists
2. Include provider type field in persistence layer
3. Create dispatch/factory pattern early (provider.ts pattern)
4. Document extension points in architecture docs
5. This aligns with UNIX principle #6: "Design with extension in mind"

**Applies to:** All external API integrations, multi-tenant features, pluggable components

**Source stories:** TM-swj

### Error responses at integration boundaries must handle non-JSON gracefully

**Priority:** Important

**Context:** DO returns plain text "Unknown action: /path" for 404s. rpcCall helper crashed when expecting JSON.

**Recommendation:** All RPC/HTTP client helpers that parse responses MUST:
1. Try JSON parse, catch SyntaxError
2. If non-JSON, return error object with raw text: `{ error: "Non-JSON response", body: rawText }`
3. Log warning if non-JSON received from expected JSON endpoint
4. Add test cases for 404, 500, plain text responses

**Applies to:** All HTTP clients, all RPC helpers, DO routing code

**Source stories:** TM-a9h
