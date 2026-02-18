/**
 * OAuth success page for the T-Minus OAuth worker.
 *
 * Renders a user-friendly HTML page after successful OAuth linking,
 * replacing the previous 404 JSON error that users saw at /oauth/{provider}/done.
 *
 * URLs:
 *   GET /oauth/google/done     -- Success page after Google OAuth
 *   GET /oauth/microsoft/done  -- Success page after Microsoft OAuth
 *
 * Query parameters (set by the callback redirect):
 *   account_id  -- The linked account ID (always present)
 *   email       -- The provider email address (optional, for display)
 *   reactivated -- "true" if an existing account was reactivated (optional)
 *
 * Design:
 * - Static HTML, no auth required
 * - Same minimal, accessible HTML style as legal.ts and support.ts
 * - Shows provider name, email, sync status, and close-tab instruction
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported OAuth provider names for the success page. */
export type OAuthProvider = "google" | "microsoft";

/** Display labels for each provider. */
const PROVIDER_LABELS: Record<OAuthProvider, string> = {
  google: "Google",
  microsoft: "Microsoft",
};

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

/**
 * Render the OAuth success page as HTML.
 *
 * @param provider - The OAuth provider ("google" or "microsoft")
 * @param email - The linked email address (may be null if not provided)
 * @param isReactivated - Whether an existing account was reactivated
 */
export function renderOAuthSuccessPage(
  provider: OAuthProvider,
  email: string | null,
  isReactivated: boolean,
): string {
  const providerLabel = PROVIDER_LABELS[provider];
  const statusMessage = isReactivated
    ? "Your account has been reconnected. Calendar sync is resuming."
    : "Your account has been linked. Calendar sync is starting.";

  const emailSection = email
    ? `<p class="detail"><strong>Email:</strong> ${escapeHtml(email)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Account Linked - T-Minus</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 600px;
      margin: 0 auto;
      padding: 2rem 1rem;
      line-height: 1.6;
      color: #1a1a1a;
      text-align: center;
    }
    .success-icon {
      font-size: 3rem;
      margin-bottom: 0.5rem;
    }
    h1 { font-size: 1.6rem; margin-bottom: 0.5rem; }
    .status { color: #2d7d2d; font-size: 1.1rem; margin: 1rem 0; }
    .details {
      background: #f5f5f5;
      border-radius: 8px;
      padding: 1rem 1.5rem;
      margin: 1.5rem 0;
      text-align: left;
    }
    .detail { margin: 0.5rem 0; }
    .close-hint {
      color: #666;
      margin-top: 2rem;
      font-size: 0.95rem;
    }
    a { color: #0066cc; }
  </style>
</head>
<body>
  <div class="success-icon" aria-hidden="true">&#10003;</div>
  <h1>${escapeHtml(providerLabel)} Account Linked</h1>
  <p class="status">${escapeHtml(statusMessage)}</p>

  <div class="details">
    <p class="detail"><strong>Provider:</strong> ${escapeHtml(providerLabel)}</p>
    ${emailSection}
    <p class="detail"><strong>Status:</strong> ${isReactivated ? "Reconnected" : "Connected"}</p>
  </div>

  <p class="close-hint">You can safely close this tab and return to the app.</p>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handle the OAuth success page request.
 *
 * Extracts provider from the URL path and query parameters from the redirect.
 */
export function handleOAuthSuccess(request: Request): Response {
  const url = new URL(request.url);

  // Determine provider from path: /oauth/google/done or /oauth/microsoft/done
  let provider: OAuthProvider;
  if (url.pathname === "/oauth/google/done") {
    provider = "google";
  } else if (url.pathname === "/oauth/microsoft/done") {
    provider = "microsoft";
  } else {
    // Should not happen if routing is correct, but handle gracefully
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const email = url.searchParams.get("email");
  const isReactivated = url.searchParams.get("reactivated") === "true";

  return new Response(renderOAuthSuccessPage(provider, email, isReactivated), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // No caching -- each visit may have different query params
      "Cache-Control": "no-store",
    },
  });
}

// ---------------------------------------------------------------------------
// HTML escaping utility
// ---------------------------------------------------------------------------

/** Escape HTML special characters to prevent XSS. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
