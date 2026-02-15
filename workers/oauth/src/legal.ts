/**
 * Legal pages for the T-Minus OAuth worker.
 *
 * Serves the privacy policy and terms of service as publicly accessible
 * HTML pages. These are required by Google's OAuth verification process
 * and Workspace Marketplace listing.
 *
 * URLs:
 *   GET /legal/privacy  -- Privacy policy
 *   GET /legal/terms    -- Terms of service
 *
 * Design:
 * - Static HTML, no auth required (public pages)
 * - Content accurately reflects actual data handling (BR-1)
 * - References GDPR right to erasure implementation (BR-2, TM-29q)
 * - Documents minimal calendar scopes (BR-3)
 */

// ---------------------------------------------------------------------------
// Privacy Policy content
// ---------------------------------------------------------------------------

/**
 * Privacy policy content sections.
 * Structured as data so tests can verify individual sections.
 */
export const PRIVACY_POLICY = {
  title: "T-Minus Privacy Policy",
  lastUpdated: "2026-02-15",
  sections: [
    {
      heading: "What Data We Collect",
      content: [
        "Calendar metadata (calendar names, time zones, colors)",
        "Event titles, start/end times, and attendee email addresses",
        "Event recurrence rules and free/busy status",
        "Your Google account email address and display name (for identity)",
      ],
    },
    {
      heading: "What Data We Do NOT Collect",
      content: [
        "Event descriptions, notes, or body content",
        "File attachments on calendar events",
        "Non-calendar Google data (Drive, Gmail, Contacts, etc.)",
        "Payment information (handled by Stripe; we never see card numbers)",
      ],
    },
    {
      heading: "How We Store Your Data",
      content: [
        "All data is encrypted at rest using AES-256-GCM envelope encryption.",
        "Data is stored in Cloudflare's edge infrastructure using Durable Objects, providing per-user isolation.",
        "OAuth tokens are encrypted with a per-account key before storage.",
        "We do not share your data with any third parties.",
      ],
    },
    {
      heading: "How We Use Your Data",
      content: [
        "To synchronize and display your calendars in a unified view.",
        "To detect scheduling conflicts across multiple calendar accounts.",
        "To provide intelligent scheduling suggestions.",
        "We do not use your data for advertising or sell it to third parties.",
      ],
    },
    {
      heading: "Data Retention and Deletion",
      content: [
        "You can disconnect any calendar account at any time, which removes all stored data for that account.",
        "You can request full account deletion via the API (GDPR Article 17 - Right to Erasure).",
        "Deletion requests include a 72-hour grace period, after which all data is permanently removed.",
        "Deletion is irreversible and cascades to all stored events, tokens, and metadata.",
      ],
    },
    {
      heading: "Your Rights (GDPR / CCPA)",
      content: [
        "Right to access: You can export all your stored data at any time.",
        "Right to rectification: Calendar data is synced from your provider; corrections should be made there.",
        "Right to erasure: Full account deletion is available via the API with a 72-hour grace period.",
        "Right to data portability: Your data can be exported in standard formats.",
        "California residents: You have the right to know what data we collect and to request its deletion under CCPA.",
      ],
    },
    {
      heading: "OAuth Scopes",
      content: [
        "We request only the minimum Google Calendar scopes necessary:",
        "- calendar (read/write access for bidirectional sync)",
        "- calendar.events (read/write access for event management)",
        "- openid, email, profile (for identity verification)",
        "We do not request access to any other Google services.",
      ],
    },
    {
      heading: "Contact",
      content: [
        "For privacy inquiries, contact: privacy@tminus.app",
      ],
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// Terms of Service content
// ---------------------------------------------------------------------------

/**
 * Terms of service content sections.
 * Structured as data so tests can verify individual sections.
 */
export const TERMS_OF_SERVICE = {
  title: "T-Minus Terms of Service",
  lastUpdated: "2026-02-15",
  sections: [
    {
      heading: "Acceptance of Terms",
      content: [
        "By using T-Minus, you agree to these terms. If you do not agree, do not use the service.",
      ],
    },
    {
      heading: "Service Description",
      content: [
        "T-Minus is a calendar federation service that unifies multiple calendar accounts (Google, Microsoft, Apple) into a single view with intelligent scheduling capabilities.",
      ],
    },
    {
      heading: "User Accounts",
      content: [
        "You are responsible for maintaining the security of your account credentials.",
        "You must provide accurate information when connecting calendar accounts.",
        "You may connect multiple calendar accounts from supported providers.",
      ],
    },
    {
      heading: "Acceptable Use",
      content: [
        "You agree not to use T-Minus for any unlawful purpose.",
        "You agree not to attempt to gain unauthorized access to other users' data.",
        "You agree not to interfere with or disrupt the service.",
        "Rate limits apply to API usage; exceeding them may result in temporary access restrictions.",
      ],
    },
    {
      heading: "Data and Privacy",
      content: [
        "Your use of T-Minus is also governed by our Privacy Policy.",
        "We encrypt all stored data and do not share it with third parties.",
        "You retain ownership of your calendar data at all times.",
      ],
    },
    {
      heading: "Service Availability",
      content: [
        "We strive for high availability but do not guarantee uninterrupted service.",
        "Scheduled maintenance will be communicated in advance when possible.",
        "We are not liable for service interruptions caused by third-party providers (Google, Microsoft, Apple).",
      ],
    },
    {
      heading: "Account Termination",
      content: [
        "You may delete your account at any time via the API.",
        "We may suspend accounts that violate these terms.",
        "Upon account deletion, all stored data is permanently removed after a 72-hour grace period.",
      ],
    },
    {
      heading: "Limitation of Liability",
      content: [
        "T-Minus is provided \"as is\" without warranties of any kind.",
        "We are not liable for any indirect, incidental, or consequential damages.",
        "Our total liability is limited to the amount you have paid for the service in the past 12 months.",
      ],
    },
    {
      heading: "Changes to Terms",
      content: [
        "We may update these terms from time to time.",
        "Continued use of the service after changes constitutes acceptance of the updated terms.",
        "Material changes will be communicated via email to registered users.",
      ],
    },
    {
      heading: "Contact",
      content: [
        "For questions about these terms, contact: legal@tminus.app",
      ],
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

/**
 * Render a legal page (privacy policy or terms of service) as HTML.
 *
 * Uses a minimal, accessible HTML structure with inline styles
 * (no external CSS dependency -- this is a static legal page).
 */
export function renderLegalPage(
  page: typeof PRIVACY_POLICY | typeof TERMS_OF_SERVICE,
): string {
  const sectionsHtml = page.sections
    .map((section) => {
      const items = section.content
        .map((item) => {
          // Lines starting with "- " are list items within a paragraph
          if (item.startsWith("- ")) {
            return `<li>${escapeHtml(item.slice(2))}</li>`;
          }
          return `<p>${escapeHtml(item)}</p>`;
        })
        .join("\n        ");

      // Wrap consecutive <li> elements in a <ul>
      const wrappedItems = items.replace(
        /(<li>.*?<\/li>\n\s*)+/gs,
        (match) => `<ul>\n        ${match}      </ul>`,
      );

      return `
      <section>
        <h2>${escapeHtml(section.heading)}</h2>
        ${wrappedItems}
      </section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(page.title)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem 1rem;
      line-height: 1.6;
      color: #1a1a1a;
    }
    h1 { font-size: 1.8rem; margin-bottom: 0.25rem; }
    h2 { font-size: 1.3rem; margin-top: 2rem; color: #333; }
    p { margin: 0.5rem 0; }
    ul { margin: 0.5rem 0; padding-left: 1.5rem; }
    li { margin: 0.25rem 0; }
    .last-updated { color: #666; font-size: 0.9rem; margin-bottom: 2rem; }
    a { color: #0066cc; }
  </style>
</head>
<body>
  <h1>${escapeHtml(page.title)}</h1>
  <p class="last-updated">Last updated: ${escapeHtml(page.lastUpdated)}</p>
  ${sectionsHtml}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** Serve the privacy policy page. */
export function handlePrivacyPolicy(): Response {
  return new Response(renderLegalPage(PRIVACY_POLICY), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

/** Serve the terms of service page. */
export function handleTermsOfService(): Response {
  return new Response(renderLegalPage(TERMS_OF_SERVICE), {
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
