# Microsoft Production Bootstrap Checklist

**Story:** TM-psbd.1
**Target identity:** `ramiro@cibertrend.com`
**Last successful bootstrap:** 2026-02-17T23:04:16Z

---

## Prerequisites

Before running the bootstrap, ensure these are in place:

1. **Azure AD App Registration** at https://entra.microsoft.com/ -> App registrations
   - Required API permissions: `Calendars.ReadWrite`, `User.Read`, `offline_access`
   - Redirect URI configured for the T-Minus OAuth flow
   - Client secret generated and not expired

2. **Environment variables** in `.env` (never committed):

   | Variable | Purpose | How to obtain |
   |----------|---------|---------------|
   | `MS_CLIENT_ID` | Azure AD Application (client) ID | Entra portal -> App registrations -> Overview |
   | `MS_CLIENT_SECRET` | Azure AD client secret | Entra portal -> App registrations -> Certificates & secrets |
   | `MS_TEST_REFRESH_TOKEN_B` | OAuth refresh token for test user | Complete OAuth consent flow (see below) |
   | `JWT_SECRET` | T-Minus API JWT signing secret | Deployed Cloudflare Workers secret |

3. **T-Minus API** deployed and healthy at `https://api.tminus.ink`

---

## Bootstrap Steps

### Step 1: Verify environment variables

```bash
# Run without logging values -- only checks presence and length
source .env && node scripts/ms-bootstrap-verify.mjs
```

Expected output: All 4 variables reported as SET with non-zero length.

### Step 2: Obtain or refresh the Microsoft refresh token

If `MS_TEST_REFRESH_TOKEN_B` is missing or expired:

1. Navigate to the T-Minus OAuth flow:
   ```
   https://login.microsoftonline.com/common/oauth2/v2.0/authorize?
     client_id=<MS_CLIENT_ID>
     &response_type=code
     &redirect_uri=<your-redirect-uri>
     &scope=Calendars.ReadWrite User.Read offline_access
     &response_mode=query
   ```
2. Sign in as `ramiro@cibertrend.com`
3. Grant consent for the requested permissions
4. Exchange the authorization code for tokens:
   ```bash
   curl -X POST https://login.microsoftonline.com/common/oauth2/v2.0/token \
     -d "grant_type=authorization_code&client_id=<MS_CLIENT_ID>&client_secret=<MS_CLIENT_SECRET>&code=<AUTH_CODE>&redirect_uri=<REDIRECT_URI>&scope=Calendars.ReadWrite User.Read offline_access"
   ```
5. Save the `refresh_token` value as `MS_TEST_REFRESH_TOKEN_B` in `.env`

### Step 3: Verify token exchange and identity

```bash
source .env && node scripts/ms-bootstrap-verify.mjs
```

Verify the output confirms:
- Token exchange: SUCCESS
- Identity: `ramiro@cibertrend.com` CONFIRMED
- Calendar access: CONFIRMED

### Step 4: Run Microsoft live tests

```bash
# Targeted Microsoft-only test run
source .env && LIVE_BASE_URL=https://api.tminus.ink \
  npx vitest run tests/live/microsoft-provider.live.test.ts \
  --config vitest.live.config.ts
```

Or run the full live suite:
```bash
make test-live
```

Verify: All 6 tests pass (MS-1 through MS-5 + MS-NEG).

### Step 5: Confirm account linkage in T-Minus

The Microsoft live tests prove:
- Token exchange works (MS-1)
- Event CRUD works against the user's calendar (MS-2 through MS-4)
- Operations meet latency targets (MS-5)
- Error handling works for invalid tokens (MS-NEG)

If the account is not yet linked in T-Minus production (no prior OAuth onboarding),
you must complete the T-Minus OAuth flow for Microsoft once:
1. Navigate to the T-Minus app
2. Connect Microsoft account via the OAuth onboarding UI
3. Sign in as `ramiro@cibertrend.com` and grant consent

---

## Auth Path for Live Suite

The live test suite supports two authentication methods:

1. **LIVE_JWT_TOKEN** (preferred for Google/CalDAV tests): A pre-generated JWT for the test user.
2. **JWT_SECRET fallback** (used by Microsoft tests): The test suite generates JWTs on-the-fly using `JWT_SECRET` and the `generateTestJWT()` helper in `tests/live/setup.ts`.

Microsoft tests use `hasMicrosoftCredentials()` which checks for `JWT_SECRET` (not `LIVE_JWT_TOKEN`). This is the approved fallback workflow: as long as `JWT_SECRET` matches the deployed secret, generated JWTs are valid.

---

## Troubleshooting

### Consent mismatch

**Symptom:** Token exchange returns `AADSTS65001: The user or administrator has not consented to use the application`.

**Cause:** The Azure AD app registration's required permissions have changed since the user last consented.

**Fix:**
1. Revoke existing consent: Entra portal -> Enterprise applications -> find app -> Permissions -> Revoke
2. Re-run the OAuth consent flow (Step 2 above)
3. Ensure the user grants ALL requested permissions

### Tenant restrictions

**Symptom:** `AADSTS50020: User account from identity provider does not exist in tenant` or `AADSTS90072`.

**Cause:** The Azure AD tenant has restrictions on which external identities can sign in, or the app is registered in a different tenant than the user's home tenant.

**Fix:**
1. Verify the app uses `/common/` (multi-tenant) endpoint, not a specific tenant ID
2. Check the app registration's "Supported account types" includes "Personal Microsoft accounts" or the user's tenant type
3. If using a single-tenant app, ensure `ramiro@cibertrend.com` belongs to that tenant

### Expired refresh token

**Symptom:** Token exchange returns `AADSTS700082: The refresh token has expired due to inactivity` or `AADSTS50173`.

**Cause:** Microsoft refresh tokens expire after 90 days of inactivity (or sooner if revoked by admin policy).

**Fix:**
1. Re-run the OAuth consent flow (Step 2) to obtain a fresh refresh token
2. Update `MS_TEST_REFRESH_TOKEN_B` in `.env`
3. Re-run verification: `source .env && node scripts/ms-bootstrap-verify.mjs`

**Prevention:** Run `make test-live` at least once per month to keep the refresh token active.

### Token exchange returns 400 with `invalid_grant`

**Symptom:** `MS token refresh failed (400): {"error":"invalid_grant",...}`

**Possible causes:**
- Refresh token was already used and a new one was issued (tokens rotate)
- Client secret expired
- App permissions were changed

**Fix:** Re-obtain the refresh token via OAuth consent flow. Check client secret expiry in Entra portal.

### Tests skip with "SKIPPED: Microsoft provider parity tests require..."

**Symptom:** Tests show as skipped, not failed.

**Cause:** One or more required env vars are missing from the test process environment.

**Fix:**
1. Verify all vars are set: `source .env && node scripts/ms-bootstrap-verify.mjs`
2. When running via `make test-live`, `LIVE_BASE_URL` is set automatically
3. Check that `.env` uses `export` prefix (e.g., `export MS_CLIENT_ID=...`) so `source .env` exports to the shell

---

## Sanitized Run Log

**Date:** 2026-02-17T23:04:16Z (UTC) / 2026-02-17T15:04:16 (PST)

### Bootstrap Verification Output

```
=== Microsoft Bootstrap Verification ===
Timestamp: 2026-02-17T23:04:16.827Z
Expected identity: ramiro@cibertrend.com

--- Step 1: Environment Variable Check ---
  MS_CLIENT_ID: SET (length=36)
  MS_CLIENT_SECRET: SET (length=40)
  MS_TEST_REFRESH_TOKEN_B: SET (length=1781)
  JWT_SECRET: SET (length=44)
  Result: ALL PRESENT

--- Step 2: Token Exchange (refresh -> access) ---
  Result: SUCCESS (698ms)
  Token type: Bearer
  Scope: Calendars.ReadWrite User.Read profile openid email
  Access token length: 2540
  Expires in: 4252s

--- Step 3: Identity Verification (Graph /me) ---
  Display name: Ramiro Salas
  Email (mail): ramiro@cibertrend.com
  UPN: ramiro@cibertrend.com
  ID: c05f8a19-****-****-****-************
  Latency: 426ms
  Identity match: CONFIRMED (ramiro@cibertrend.com)

--- Step 4: Calendar Access Check ---
  Default calendar: Calendar
  Calendar ID (truncated): AAMkADQ0ZGJmMWI4LTMyMjEtNGE1NC...
  Latency: 408ms
  Calendar access: CONFIRMED

=== Bootstrap Verification Summary ===
Identity: ramiro@cibertrend.com - CONFIRMED
Token exchange: PASS
Calendar access: PASS
All checks: PASS
```

### Live Test Output

```
 RUN  v3.2.4

 + |live| tests/live/microsoft-provider.live.test.ts (6 tests) 4190ms
   + MS-1: Microsoft token exchange succeeds and returns valid access token  1124ms
   + MS-2: Create event in Microsoft Calendar returns valid event ID  1324ms
   + MS-3: Update event title propagates in Microsoft Calendar  765ms
   + MS-4: Delete event removes it from Microsoft Calendar  787ms
   + MS-5: All Microsoft operations complete within latency targets
   + MS-NEG: Invalid Microsoft refresh token returns clear error

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Duration  4.51s

 Latency Summary:
   TOKEN_EXCHANGE: 745ms (0.7s) -- PASS (target < 30s)
   CREATE:         1075ms (1.1s) -- PASS (target < 30s)
   UPDATE:         396ms (0.4s)  -- PASS (target < 30s)
   DELETE:         516ms (0.5s)  -- PASS (target < 30s)
```
