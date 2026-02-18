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
  const statusLabel = isReactivated ? "Reconnected" : "Connected";
  const statusMessage = isReactivated
    ? "Your account has been reconnected. Calendar sync is resuming."
    : "Your account has been linked. Calendar sync is starting.";
  const nextStepMessage = isReactivated
    ? "T-Minus will continue syncing updates from this calendar in the background."
    : "T-Minus is now importing your availability and will keep it up to date automatically.";

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
      margin: 0;
      min-height: 100vh;
      padding: 1.5rem;
      line-height: 1.6;
      color: #1f2937;
      display: flex;
      align-items: center;
      justify-content: center;
      background:
        radial-gradient(circle at 20% 10%, #dbeafe, transparent 35%),
        radial-gradient(circle at 80% 90%, #dcfce7, transparent 30%),
        #f8fafc;
    }
    .card {
      width: 100%;
      max-width: 680px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 16px;
      box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
      padding: 2rem 1.5rem;
      text-align: center;
    }
    .success-icon {
      width: 56px;
      height: 56px;
      margin: 0 auto 0.75rem;
      border-radius: 999px;
      background: #ecfdf3;
      color: #166534;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
      font-weight: 700;
    }
    h1 {
      margin: 0.25rem 0 0.25rem;
      font-size: 1.8rem;
      line-height: 1.2;
      color: #0f172a;
    }
    .headline-subtitle {
      margin: 0.25rem 0 1.25rem;
      color: #475569;
      font-size: 1rem;
    }
    .status {
      color: #166534;
      font-size: 1.05rem;
      margin: 0.75rem 0 0.5rem;
      font-weight: 600;
    }
    .next-step {
      color: #334155;
      margin: 0.25rem 0 1.25rem;
    }
    .details {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 1rem 1.25rem;
      margin: 1.25rem 0;
      text-align: left;
    }
    .detail {
      margin: 0.5rem 0;
      word-break: break-word;
    }
    .actions {
      margin-top: 1.25rem;
    }
    .button {
      display: inline-block;
      background: #0f172a;
      color: #ffffff;
      text-decoration: none;
      font-weight: 600;
      padding: 0.65rem 1rem;
      border-radius: 10px;
    }
    .button:hover {
      background: #1e293b;
    }
    .close-hint {
      color: #666;
      margin-top: 1.2rem;
      font-size: 0.95rem;
    }
    .note {
      color: #64748b;
      margin-top: 0.35rem;
      font-size: 0.9rem;
    }
    a { color: #2563eb; }
    @media (max-width: 600px) {
      body {
        padding: 1rem;
      }
      .card {
        padding: 1.5rem 1rem;
      }
      h1 {
        font-size: 1.5rem;
      }
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="success-icon" aria-hidden="true">OK</div>
    <h1>${escapeHtml(providerLabel)} Account Linked</h1>
    <p class="headline-subtitle">You are now ready to plan with complete availability context.</p>
    <p class="status">${escapeHtml(statusMessage)}</p>
    <p class="next-step">${escapeHtml(nextStepMessage)}</p>

    <div class="details">
      <p class="detail"><strong>Provider:</strong> ${escapeHtml(providerLabel)}</p>
      ${emailSection}
      <p class="detail"><strong>Status:</strong> ${statusLabel}</p>
      <p class="detail"><strong>Sync:</strong> Active</p>
    </div>

    <div class="actions">
      <a class="button" href="https://app.tminus.ink">Open T-Minus</a>
    </div>
    <p class="note">Need help? Visit <a href="/support">Support</a>.</p>
    <p class="close-hint">You can safely close this tab and return to the app.</p>
  </main>
</body>
</html>
`;
}

function renderOAuthDoneNotFoundPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Link Page Not Found - T-Minus</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f8fafc;
      color: #1f2937;
      padding: 1rem;
    }
    .card {
      max-width: 560px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 1.5rem 1.25rem;
      text-align: center;
    }
    h1 {
      margin: 0 0 0.5rem;
      color: #0f172a;
    }
    p {
      margin: 0.5rem 0;
      color: #475569;
    }
    a {
      color: #2563eb;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Link Page Not Found</h1>
    <p>The link completion page could not be found.</p>
    <p>Return to <a href="https://app.tminus.ink">T-Minus</a> and try connecting again.</p>
  </main>
</body>
</html>`;
}

function normalizePathname(pathname: string): string {
  if (pathname === "/") {
    return "/";
  }
  return pathname.replace(/\/+$/, "") || "/";
}

function extractProviderFromPath(pathname: string): OAuthProvider | null {
  const match = pathname.match(/^\/oauth\/(google|microsoft)\/done$/);
  if (!match) {
    return null;
  }
  return match[1] as OAuthProvider;
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
  const provider = extractProviderFromPath(normalizePathname(url.pathname));

  if (!provider) {
    return new Response(renderOAuthDoneNotFoundPage(), {
      status: 404,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
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
