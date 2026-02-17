# Authentication

## Bearer Token Authentication

All API requests require a valid bearer token:

```
Authorization: Bearer <token>
```

The api-worker resolves the token to a `user_id`. All subsequent operations
are scoped to that user.

## OAuth Flow

T-Minus uses Google OAuth 2.0 with PKCE for account linking.

### Flow Diagram

```
                                 T-Minus System
  User Browser                   (oauth-worker)                Google
  +-----------+                 +--------------+            +----------+
  |           |  1. GET /oauth  |              |            |          |
  |           | /google/start   |              |            |          |
  |           +---------------->| Generate     |            |          |
  |           |                 | PKCE pair    |            |          |
  |           |  2. 302         | Store state  |            |          |
  |           |<----------------+ in cookie    |            |          |
  |           |                 |              |            |          |
  |           |  3. Redirect    |              |            |          |
  |           +-------------------------------------------->|          |
  |           |                 |              |  4. User   |          |
  |           |                 |              |  consents  |          |
  |           |  5. Redirect    |              |            |          |
  |           |  with code      |              |            |          |
  |           +---------------->| 6. Exchange  |            |          |
  |           |                 |    code for  +----------->|          |
  |           |                 |    tokens    |<-----------+          |
  |           |                 |              |            |          |
  |           |                 | 7. Create    |            |          |
  |           |                 |    AccountDO |            |          |
  |           |                 |    + D1 row  |            |          |
  |           |                 |              |            |          |
  |           |                 | 8. Start     |            |          |
  |           |                 |    Onboarding|            |          |
  |           |                 |    Workflow   |            |          |
  |           |                 |              |            |          |
  |           |  9. Redirect    |              |            |          |
  |           |  to success URL |              |            |          |
  |           |<----------------+              |            |          |
  +-----------+                 +--------------+            +----------+
```

### Endpoints

**GET /oauth/google/start**

Query params:
- `user_id` (required): The authenticated user linking a new account
- `redirect_uri` (optional): Where to send the user after completion

Behavior:
1. Generate PKCE code_verifier and code_challenge
2. Generate cryptographic `state` parameter
3. Store `{state, code_verifier, user_id, redirect_uri}` in a short-lived signed cookie (5 min TTL) or KV entry
4. Redirect to Google OAuth consent screen with scopes:
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/calendar.events`
   - `openid email profile` (for provider_subject identification)

**GET /oauth/google/callback**

Query params (from Google):
- `code`: Authorization code
- `state`: Must match stored state

Behavior:
1. Validate `state` against stored value. If mismatch, return error page.
2. Exchange `code` for tokens using PKCE code_verifier
3. Fetch Google userinfo to get `sub` (provider_subject) and `email`
4. Check D1: does an account with this `(provider, provider_subject)` exist?
   - If yes and same user: re-activate, update tokens
   - If yes and different user: reject with `ACCOUNT_ALREADY_LINKED` error
   - If no: create new account
5. Create/update AccountDO with encrypted tokens
6. Insert/update D1 accounts registry row
7. Start OnboardingWorkflow for initial sync
8. Redirect user to success URL with `?account_id=acc_01H...`

### Error States

| Scenario | User Sees | System Action |
|----------|-----------|---------------|
| State mismatch | "Link failed. Please try again." | Log warning, no account created |
| Google consent denied | "You declined access. No account linked." | Clean redirect, no retry |
| Token exchange fails | "Something went wrong. Please try again." | Log error with request_id |
| Account already linked to another user | "This Google account is already linked to a different T-Minus account." | 409 Conflict, no change |
| Duplicate link (same user) | Silent success, tokens refreshed | Re-activate existing account |
| Google scopes insufficient | "We need calendar access to sync. Please re-authorize." | Redirect back to consent |

### Security Considerations

- PKCE is mandatory (no client_secret in browser flow)
- State parameter prevents CSRF
- Tokens are encrypted immediately upon receipt (never stored in plaintext)
- Refresh tokens never leave AccountDO
- OAuth client_secret stored as Cloudflare Secret, not in code
