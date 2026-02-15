/**
 * Support page for the T-Minus OAuth worker.
 *
 * Serves the support page as a publicly accessible HTML page.
 * Required by Google Workspace Marketplace listing -- the manifest
 * references /support as the support_url.
 *
 * URL:
 *   GET /support  -- Support page with FAQ and contact info
 *
 * Design:
 * - Static HTML, no auth required (public page)
 * - Same minimal, accessible HTML style as legal.ts
 * - FAQ covers common questions from Marketplace users
 * - Contact email for support inquiries
 */

// ---------------------------------------------------------------------------
// Support page content
// ---------------------------------------------------------------------------

/** FAQ item structure. */
export interface FaqItem {
  /** The question being answered. */
  readonly question: string;
  /** The answer to the question. */
  readonly answer: string;
}

/** Support page content structure. */
export interface SupportPageContent {
  /** Page title. */
  readonly title: string;
  /** Support contact email. */
  readonly contactEmail: string;
  /** Frequently asked questions. */
  readonly faq: readonly FaqItem[];
}

/**
 * Support page content.
 * Structured as data so tests can verify individual sections.
 */
export const SUPPORT_PAGE: SupportPageContent = {
  title: "T-Minus Support",
  contactEmail: "support@tminus.app",
  faq: [
    {
      question: "How do I connect my calendars?",
      answer:
        "After installing T-Minus, you will be guided through a simple onboarding flow. " +
        "Click 'Connect' next to each calendar provider (Google, Microsoft, or Apple) " +
        "and authorize access. Your calendars will begin syncing immediately.",
    },
    {
      question: "Is my data secure?",
      answer:
        "Yes. All data is encrypted at rest using AES-256-GCM envelope encryption. " +
        "Your calendar data is stored in per-user isolated Durable Objects on " +
        "Cloudflare's edge network. OAuth tokens are encrypted with per-account keys. " +
        "We never share your data with third parties.",
    },
    {
      question: "How do I disconnect a calendar account?",
      answer:
        "You can disconnect any calendar account at any time from the account " +
        "management page. Disconnecting removes all stored data for that account, " +
        "including events and OAuth tokens.",
    },
    {
      question: "How do I delete my account entirely?",
      answer:
        "You can request full account deletion via the API. Deletion includes a " +
        "72-hour grace period, after which all data is permanently and irreversibly " +
        "removed. This complies with GDPR Article 17 (Right to Erasure).",
    },
    {
      question: "What calendar providers are supported?",
      answer:
        "T-Minus supports Google Workspace (Google Calendar), Microsoft 365 " +
        "(Outlook Calendar), and Apple iCloud Calendar. Each provider can have " +
        "multiple accounts connected simultaneously.",
    },
    {
      question: "Why does T-Minus need calendar read/write access?",
      answer:
        "T-Minus needs read access to fetch your events for the unified view and " +
        "conflict detection. Write access is needed to create busy-overlay events " +
        "when you connect multiple providers, ensuring your availability is " +
        "reflected across all calendars. We request only the minimum scopes needed " +
        "and do not access Gmail, Drive, or any other Google services.",
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

/**
 * Render the support page as HTML.
 *
 * Uses the same minimal, accessible HTML structure as legal.ts
 * with inline styles (no external CSS dependency).
 */
export function renderSupportPage(): string {
  const faqHtml = SUPPORT_PAGE.faq
    .map(
      (item) => `
      <div class="faq-item">
        <h3>${escapeHtml(item.question)}</h3>
        <p>${escapeHtml(item.answer)}</p>
      </div>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(SUPPORT_PAGE.title)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem 1rem;
      line-height: 1.6;
      color: #1a1a1a;
    }
    h1 { font-size: 1.8rem; margin-bottom: 0.5rem; }
    h2 { font-size: 1.4rem; margin-top: 2rem; color: #333; }
    h3 { font-size: 1.1rem; margin-top: 1.5rem; margin-bottom: 0.25rem; color: #222; }
    p { margin: 0.5rem 0; }
    .contact { margin: 1.5rem 0; padding: 1rem; background: #f5f5f5; border-radius: 8px; }
    .contact a { color: #0066cc; }
    .faq-item { margin-bottom: 1rem; }
    a { color: #0066cc; }
  </style>
</head>
<body>
  <h1>${escapeHtml(SUPPORT_PAGE.title)}</h1>
  <p>Need help with T-Minus? Check the FAQ below or contact us directly.</p>

  <div class="contact">
    <strong>Contact Us:</strong>
    <a href="mailto:${escapeHtml(SUPPORT_PAGE.contactEmail)}">${escapeHtml(SUPPORT_PAGE.contactEmail)}</a>
  </div>

  <h2>Frequently Asked Questions</h2>
  ${faqHtml}

  <h2>Additional Resources</h2>
  <p>
    <a href="/legal/privacy">Privacy Policy</a> |
    <a href="/legal/terms">Terms of Service</a>
  </p>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/** Serve the support page. */
export function handleSupportPage(): Response {
  return new Response(renderSupportPage(), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
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
