# Security Overview

---

## Token Encryption (Envelope Encryption)

```
Master Key
  |
  | (stored in Cloudflare Secret, per environment)
  |
  v
Per-Account DEK (Data Encryption Key)
  |
  | (generated at account creation, unique per AccountDO)
  | (DEK encrypted with master key, stored in AccountDO SQLite)
  |
  v
OAuth Tokens
  (encrypted with DEK using AES-256-GCM)
  (stored in AccountDO auth table as encrypted_tokens)
```

- **Master key:** stored as Cloudflare Secret (`MASTER_KEY`), rotatable per env.
- **Per-account DEK:** generated via `crypto.subtle.generateKey()` at account creation. Encrypted with master key. Stored alongside tokens.
- **Access tokens:** minted JIT by `AccountDO.getAccessToken()`. The DO decrypts the DEK with the master key, decrypts tokens with the DEK, checks expiry, refreshes if needed, re-encrypts, and returns the access token.
- **Refresh tokens:** NEVER leave the AccountDO boundary. Queue consumers receive only short-lived access tokens.

See [ADR-007](../decisions/adr-007-secrets-centralization.md) for the secrets centralization decision.

---

## Webhook Validation

All webhook requests from Google are validated before any processing:

1. Verify `X-Goog-Channel-Token` matches the token stored against the channel_id in D1.
2. Verify `X-Goog-Resource-State` is a known value (`sync`, `exists`, `not_exists`).
3. Reject unknown `channel_id` / `resource_id` combinations.
4. Rate-limit webhook endpoint per source IP (Cloudflare Rate Limiting).
5. Return 200 immediately after enqueuing -- never block webhook response on downstream processing.

---

## API Authentication

- Short-lived session tokens or JWTs tied to user_id
- Token validation on every API request before touching DOs
- Scoped access: a user can only access their own UserGraphDO
- MCP endpoint uses the same auth layer with per-tool authorization

---

## Privacy (GDPR / CCPA / CPRA)

### Data Minimization

- Participant identifiers stored as `SHA-256(email + per-org salt)`.
- Event content optionally encrypted at rest (user-controlled setting).
- Only data required for sync + policy is collected. No free-form attendee metadata unless explicitly needed.

### Right to Erasure (Full Deletion)

Executed via a deletion Workflow that cascades:

1. Delete canonical events from UserGraphDO SQLite
2. Delete event mirrors from UserGraphDO SQLite
3. Delete journal entries from UserGraphDO SQLite
4. Delete relationship/ledger/milestone data
5. Delete D1 registry rows (users, accounts)
6. Delete R2 audit objects
7. Enqueue provider-side mirror deletions
8. Generate signed deletion certificate

No soft deletes. Tombstone structural references only (foreign key stubs with all PII removed).

### Deletion Certificates

- Stored in D1 `deletion_certificates` table.
- Contain: `entity_type`, `entity_id`, `deleted_at`, `proof_hash` (SHA-256 of deleted data summary), `signature` (system key).
- Prove what was deleted and when, without retaining the deleted data.

---

## Tenant Isolation

- Durable Object IDs derived deterministically from `user_id` (UserGraphDO) or `account_id` (AccountDO). A user cannot address another user's DO.
- D1 queries always filter by `user_id` / `org_id`.
- No shared mutable state between users except through explicit scheduling sessions (Phase 3+, mediated by GroupScheduleDO).

---

## Non-Functional Security Requirements

| ID | Requirement |
|----|-------------|
| NFR-9 | OAuth tokens encrypted with AES-256-GCM using per-account DEKs. DEK encrypted with master key in Cloudflare Secrets. |
| NFR-10 | Refresh tokens never leave AccountDO boundary. |
| NFR-11 | Webhook validates X-Goog-Channel-Token, X-Goog-Resource-State, rejects unknown channel/resource IDs. |
| NFR-12 | Webhook rate-limited per source IP. |
| NFR-13 | API authentication required for all endpoints. |
