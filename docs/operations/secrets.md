# Secrets Management

This document describes all secrets required by T-Minus workers, which workers
need them, and how to deploy them across environments.

---

## Quick Start

```bash
# 1. Copy .env.example and fill in real values
cp .env.example .env
# Edit .env with your actual secret values

# 2. Preview what would be deployed (no changes made)
make secrets-setup-dry-run

# 3. Deploy all secrets to all environments
make secrets-setup

# 4. Deploy to a single environment
make secrets-setup-staging
make secrets-setup-production
```

---

## Secret Registry

### JWT_SECRET

| Property | Value |
|----------|-------|
| **Purpose** | JWT signing and verification for API authentication |
| **Workers** | tminus-api, tminus-oauth |
| **Generate** | `openssl rand -base64 32` |
| **Rotation** | Invalidates all active sessions. Coordinate with maintenance window. |

JWT_SECRET must be **identical** across tminus-api and tminus-oauth to ensure tokens signed by one worker can be verified by the other.

### MASTER_KEY

| Property | Value |
|----------|-------|
| **Purpose** | Envelope encryption master key for DEK wrapping |
| **Workers** | tminus-api, tminus-oauth |
| **Generate** | `openssl rand -base64 32` |
| **Rotation** | Requires re-encryption of all stored DEKs. NOT a simple rotation -- requires migration. |

MASTER_KEY is used by AccountDO (hosted on tminus-api) to encrypt OAuth tokens at rest using envelope encryption. **Losing this key means losing access to all encrypted OAuth tokens.**

### GOOGLE_CLIENT_ID

| Property | Value |
|----------|-------|
| **Purpose** | Google OAuth 2.0 client ID |
| **Workers** | tminus-api, tminus-oauth |
| **Source** | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) |
| **Rotation** | Create new OAuth client, update secret, update redirect URIs. |

### GOOGLE_CLIENT_SECRET

| Property | Value |
|----------|-------|
| **Purpose** | Google OAuth 2.0 client secret |
| **Workers** | tminus-api, tminus-oauth |
| **Source** | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) |
| **Rotation** | Rotate with GOOGLE_CLIENT_ID. All connected accounts will need re-authorization. |

### MS_CLIENT_ID

| Property | Value |
|----------|-------|
| **Purpose** | Microsoft Entra ID (Azure AD) application client ID |
| **Workers** | tminus-api, tminus-oauth |
| **Source** | [Microsoft Entra Admin Center](https://entra.microsoft.com/) > App registrations |
| **Rotation** | Create new app registration, update secret, update redirect URIs. |

### MS_CLIENT_SECRET

| Property | Value |
|----------|-------|
| **Purpose** | Microsoft Entra ID (Azure AD) application client secret |
| **Workers** | tminus-api, tminus-oauth |
| **Source** | [Microsoft Entra Admin Center](https://entra.microsoft.com/) > App registrations > Certificates & secrets |
| **Rotation** | Microsoft client secrets have configurable expiry (max 2 years). Rotate before expiry. |

---

## Workers and Their Secrets

### tminus-api

Hosts UserGraphDO and AccountDO. AccountDO handles calendar account management including OAuth token refresh and encrypted token storage.

| Secret | Purpose on this worker |
|--------|----------------------|
| JWT_SECRET | Auth middleware: JWT signing and verification |
| MASTER_KEY | AccountDO: DEK encryption for OAuth token storage |
| GOOGLE_CLIENT_ID | AccountDO: Google Calendar token refresh |
| GOOGLE_CLIENT_SECRET | AccountDO: Google Calendar token refresh |
| MS_CLIENT_ID | AccountDO: Microsoft 365 Calendar token refresh |
| MS_CLIENT_SECRET | AccountDO: Microsoft 365 Calendar token refresh |

### tminus-oauth

Handles OAuth authorization flows (redirect, callback, token exchange). Hosts OnboardingWorkflow.

| Secret | Purpose on this worker |
|--------|----------------------|
| JWT_SECRET | State token signing for OAuth CSRF protection |
| MASTER_KEY | Shared envelope encryption with api worker |
| GOOGLE_CLIENT_ID | Google OAuth authorization code exchange |
| GOOGLE_CLIENT_SECRET | Google OAuth authorization code exchange |
| MS_CLIENT_ID | Microsoft OAuth authorization code exchange |
| MS_CLIENT_SECRET | Microsoft OAuth authorization code exchange |

---

## Environments

Secrets must be set **independently** for each environment because wrangler environments create separate worker instances.

| Environment | Worker naming | Example |
|-------------|--------------|---------|
| staging | `tminus-{worker}-staging` | `tminus-api-staging` |
| production | `tminus-{worker}-production` | `tminus-api-production` |

### Staging vs Production Values

- **JWT_SECRET** and **MASTER_KEY**: Use DIFFERENT values for staging and production.
- **OAuth credentials**: Can use the same Google/Microsoft OAuth app for both (with redirect URIs for both environments), or separate apps for complete isolation.

---

## Deployment Matrix

| Secret | tminus-api-staging | tminus-api-production | tminus-oauth-staging | tminus-oauth-production |
|--------|:--:|:--:|:--:|:--:|
| JWT_SECRET | X | X | X | X |
| MASTER_KEY | X | X | X | X |
| GOOGLE_CLIENT_ID | X | X | X | X |
| GOOGLE_CLIENT_SECRET | X | X | X | X |
| MS_CLIENT_ID | X | X | X | X |
| MS_CLIENT_SECRET | X | X | X | X |

**Total: 24 secret deployments** (6 secrets x 2 workers x 2 environments)

---

## CLI Reference

```bash
make secrets-setup              # Deploy all secrets to all environments
make secrets-setup-staging      # Deploy to staging only
make secrets-setup-production   # Deploy to production only
make secrets-setup-dry-run      # Preview without making changes

# Advanced: filter by worker
. ./.env && node scripts/setup-secrets.mjs --env production --worker api

# Advanced: verbose output
. ./.env && node scripts/setup-secrets.mjs --verbose
```

---

## How It Works

1. Reads secret values from `.env` file in project root
2. Builds a deployment plan based on the SECRETS_REGISTRY (which maps secrets to workers)
3. For each secret/worker/environment combination, executes `npx wrangler secret put`
4. Secret values are piped via stdin (never exposed on command line or in logs)
5. Wrangler `secret put` is an upsert operation -- idempotent and safe to re-run

---

## Security Notes

- **Never commit `.env`** to git. It is in `.gitignore`.
- Secret values are piped to wrangler via stdin, never passed as CLI arguments.
- Secrets are stored encrypted at rest in Cloudflare's infrastructure.
- Secrets are only accessible to the specific worker they are set on.
- Each wrangler environment has its own independent set of secrets.
- Generate cryptographic secrets with `openssl rand -base64 32` (not manually).
