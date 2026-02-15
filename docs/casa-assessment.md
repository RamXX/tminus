# CASA (Cloud Application Security Assessment) Documentation

## Application Overview

**Application Name:** T-Minus
**Description:** Calendar federation engine that unifies Google, Microsoft, and Apple calendar accounts into a single view with intelligent scheduling.
**OAuth Scopes Requested:** calendar, calendar.events, openid, email, profile

## Data Flow

```
User Browser
    |
    v
[Google OAuth Consent Screen]
    |
    | (Authorization code + PKCE)
    v
[T-Minus OAuth Worker] (Cloudflare Workers)
    |
    | (Token exchange via HTTPS)
    v
[Google Token Endpoint]
    |
    | (Access token + Refresh token)
    v
[T-Minus OAuth Worker]
    |
    | (Encrypted tokens stored)
    v
[AccountDO] (Cloudflare Durable Object, per-account isolation)
    |
    | (Sync via Google Calendar API)
    v
[UserGraphDO] (Cloudflare Durable Object, per-user isolation)
    |
    | (Encrypted canonical events)
    v
[DO SQLite] (Per-user encrypted storage)
```

### Data Flow Summary

1. **Authentication:** User authenticates via Google OAuth2 with PKCE (S256). Authorization code is exchanged for tokens server-side.
2. **Token Storage:** Access and refresh tokens are encrypted with AES-256-GCM envelope encryption before storage in AccountDO.
3. **Calendar Sync:** Events are fetched from Google Calendar API using the access token, canonicalized, and stored in UserGraphDO.
4. **Data Access:** Users access their data only through authenticated API calls (JWT HS256 bearer tokens).

## Encryption

### At Rest

| Data | Encryption | Location |
|------|-----------|----------|
| OAuth tokens (access, refresh) | AES-256-GCM per-account envelope encryption | AccountDO (Cloudflare Durable Object) |
| Calendar events | AES-256-GCM per-user envelope encryption | UserGraphDO SQLite (Cloudflare Durable Object) |
| User metadata | AES-256-GCM | UserGraphDO SQLite |
| D1 registry (account lookup) | Cloudflare-managed encryption | D1 (Cloudflare edge database) |

### In Transit

| Path | Encryption |
|------|-----------|
| User -> T-Minus | TLS 1.3 (Cloudflare edge) |
| T-Minus -> Google APIs | TLS 1.3 |
| T-Minus -> Microsoft Graph | TLS 1.3 |
| Worker -> Durable Object | Internal Cloudflare network (encrypted) |

### Key Management

- **Envelope encryption:** Each account and user has a unique data encryption key (DEK) encrypted by a key encryption key (KEK).
- **KEK derivation:** Derived from the worker's JWT_SECRET using HKDF.
- **No plaintext tokens:** OAuth tokens are never stored in plaintext. The stored blob is AES-256-GCM ciphertext with a random IV.
- **Token rotation:** Access tokens are refreshed automatically; refresh tokens are re-encrypted on each rotation.

## Access Controls

### Per-User Isolation

T-Minus uses Cloudflare Durable Objects for per-user data isolation:

- **UserGraphDO:** One instance per user. Contains all calendar events, policies, and metadata for that user only. Named by `user_id`.
- **AccountDO:** One instance per connected calendar account. Contains encrypted OAuth tokens and sync state. Named by `account_id`.
- **No cross-user access:** A user's DO can only be accessed with a valid JWT containing their `user_id`. There is no API endpoint that returns another user's data.

### Authentication

- **JWT HS256:** All API requests require a valid JWT bearer token.
- **Token expiry:** JWTs expire after a configurable period.
- **API keys:** Alternative authentication via hashed API keys (bcrypt).
- **Re-authentication:** Account deletion requires password re-verification.

### Authorization

- **User-scoped:** All data operations are scoped to the authenticated user.
- **No admin panel:** There is no administrative interface that can access user data.
- **Rate limiting:** Per-user and per-IP rate limiting on all endpoints.

## Data Minimization

### What We Collect

- Calendar metadata (names, time zones)
- Event titles, start/end times, attendee email addresses
- Event recurrence rules and free/busy status
- Google account email and display name

### What We Do NOT Collect

- Event descriptions, notes, or body content
- File attachments
- Non-calendar Google data (Drive, Gmail, Contacts)
- Payment card numbers (handled by Stripe)

## Data Retention

- **Active accounts:** Data retained while account is connected.
- **Disconnected accounts:** All stored data for that account is removed.
- **Account deletion:** Full erasure with 72-hour grace period (GDPR Article 17).
- **Deletion cascading:** Removes all events, tokens, metadata, and DO state.
- **No backups retained:** Durable Object deletion is permanent.

## Third-Party Data Sharing

**T-Minus does not share user data with any third parties.**

- No advertising networks
- No analytics services that receive PII
- No data brokers
- Stripe processes payments but never receives calendar data

## Incident Response

- **Monitoring:** Cloudflare Workers analytics and error tracking.
- **Token revocation:** If a breach is detected, all OAuth tokens can be rotated via AccountDO.
- **User notification:** Users will be notified within 72 hours of any data breach (GDPR requirement).

## Compliance

- **GDPR:** Right to access, rectification, erasure, and data portability implemented.
- **CCPA:** California resident rights honored (know, delete, opt-out).
- **Google OAuth Policy:** Minimal scopes, clear data usage disclosure, user consent.

## Infrastructure

- **Runtime:** Cloudflare Workers (V8 isolates, no persistent server state).
- **Storage:** Cloudflare Durable Objects (SQLite per-DO, encrypted at rest by Cloudflare).
- **Database:** Cloudflare D1 (for cross-user registry lookups only).
- **CDN/Edge:** Cloudflare global edge network.
- **No self-hosted servers:** Entire stack runs on Cloudflare's infrastructure.
- **SOC 2 Type II:** Cloudflare maintains SOC 2 Type II certification.
- **ISO 27001:** Cloudflare is ISO 27001 certified.
