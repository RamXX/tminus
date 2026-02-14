/**
 * Microsoft Entra ID (Azure AD) OAuth2 configuration constants.
 *
 * Uses the "common" tenant endpoint which supports both personal
 * Microsoft accounts and organizational (work/school) accounts.
 */

/** Microsoft OAuth2 authorization endpoint (common tenant). */
export const MS_AUTH_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";

/** Microsoft OAuth2 token exchange and refresh endpoint (common tenant). */
export const MS_TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";

/** Microsoft Graph userinfo endpoint for retrieving profile and email. */
export const MS_USERINFO_URL = "https://graph.microsoft.com/v1.0/me";

/**
 * OAuth scopes requested for Microsoft Calendar access + identity.
 *
 * - Calendars.ReadWrite: read/write calendar events
 * - User.Read: read user profile (sub, email, displayName)
 * - offline_access: obtain a refresh token
 */
export const MS_SCOPES = "Calendars.ReadWrite User.Read offline_access";

/** The callback path on this worker that Microsoft redirects to. */
export const MS_CALLBACK_PATH = "/oauth/microsoft/callback";
