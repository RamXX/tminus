/**
 * Google OAuth2 configuration constants.
 */

/** Google OAuth2 authorization endpoint. */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** Google OAuth2 token exchange endpoint. */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Google userinfo endpoint for retrieving sub and email. */
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

/** OAuth scopes requested for Google Calendar access + identity. */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  "openid",
  "email",
  "profile",
].join(" ");

/** The callback path on this worker that Google redirects to. */
export const CALLBACK_PATH = "/oauth/google/callback";
