/**
 * Commitment proof infrastructure: types, hashing, document generation, and
 * cryptographic signing/verification.
 *
 * Extracted from commitments.ts for single-responsibility decomposition.
 */

// ---------------------------------------------------------------------------
// Proof types
// ---------------------------------------------------------------------------

/** Shape of a single event in a commitment proof export. */
export interface ProofEvent {
  canonical_event_id: string;
  title: string | null;
  start_ts: string;
  end_ts: string;
  hours: number;
  billing_category: string;
}

/** Shape of the proof data returned by the UserGraphDO. */
export interface CommitmentProofData {
  commitment: {
    commitment_id: string;
    client_id: string;
    client_name: string | null;
    window_type: string;
    target_hours: number;
    rolling_window_weeks: number;
    hard_minimum: boolean;
    proof_required: boolean;
    created_at: string;
  };
  window_start: string;
  window_end: string;
  actual_hours: number;
  status: string;
  events: ProofEvent[];
}

// ---------------------------------------------------------------------------
// Proof hashing
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 hash of the canonical proof data.
 *
 * The hash is computed over a deterministic JSON serialization of the
 * proof payload (commitment + window + events). This allows anyone with
 * the data to independently verify the hash.
 */
export async function computeProofHash(data: CommitmentProofData): Promise<string> {
  // Build a deterministic canonical representation for hashing.
  // Keys are sorted implicitly by the order we construct the object.
  const canonical = {
    commitment_id: data.commitment.commitment_id,
    client_id: data.commitment.client_id,
    client_name: data.commitment.client_name,
    window_type: data.commitment.window_type,
    target_hours: data.commitment.target_hours,
    window_start: data.window_start,
    window_end: data.window_end,
    actual_hours: data.actual_hours,
    status: data.status,
    events: data.events.map((e) => ({
      canonical_event_id: e.canonical_event_id,
      title: e.title,
      start_ts: e.start_ts,
      end_ts: e.end_ts,
      hours: e.hours,
      billing_category: e.billing_category,
    })),
  };

  const encoded = new TextEncoder().encode(JSON.stringify(canonical));
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Document generation helpers
// ---------------------------------------------------------------------------

/** Escape a string for CSV (wrap in quotes if it contains comma, quote, or newline). */
function csvEscape(str: string): string {
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Escape HTML special characters to prevent XSS in generated documents. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ---------------------------------------------------------------------------
// Document generation
// ---------------------------------------------------------------------------

/**
 * Generate CSV content from commitment proof data.
 *
 * Format:
 * - Header row with column names
 * - One row per event
 * - Summary row at bottom with totals and hash
 */
export function generateProofCsv(data: CommitmentProofData, proofHash: string): string {
  const lines: string[] = [];

  // Metadata header
  lines.push("# Commitment Proof Export");
  lines.push(`# Commitment ID: ${data.commitment.commitment_id}`);
  lines.push(`# Client: ${data.commitment.client_name ?? data.commitment.client_id}`);
  lines.push(`# Window Type: ${data.commitment.window_type}`);
  lines.push(`# Window: ${data.window_start} to ${data.window_end}`);
  lines.push(`# Target Hours: ${data.commitment.target_hours}`);
  lines.push(`# Actual Hours: ${data.actual_hours}`);
  lines.push(`# Status: ${data.status}`);
  lines.push(`# Proof Hash (SHA-256): ${proofHash}`);
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push("");

  // CSV header
  lines.push("event_id,title,start,end,hours,billing_category");

  // Event rows
  for (const event of data.events) {
    const title = csvEscape(event.title ?? "");
    lines.push(
      `${event.canonical_event_id},${title},${event.start_ts},${event.end_ts},${event.hours},${event.billing_category}`,
    );
  }

  // Summary row
  lines.push("");
  lines.push(`# Total Events: ${data.events.length}`);
  lines.push(`# Total Hours: ${data.actual_hours}`);

  return lines.join("\n");
}

/**
 * Generate a text-based proof document (used as the "PDF" output).
 *
 * In a Workers environment, true PDF generation is impractical without
 * large libraries. This produces a structured, human-readable text document
 * that contains all the verifiable data. The Content-Type is set to
 * application/pdf and the content is a plain-text representation that
 * can be saved and verified.
 */
export function generateProofDocument(data: CommitmentProofData, proofHash: string): string {
  const lines: string[] = [];
  const divider = "=".repeat(72);
  const thinDivider = "-".repeat(72);

  lines.push(divider);
  lines.push("                    COMMITMENT PROOF DOCUMENT");
  lines.push(divider);
  lines.push("");
  lines.push(`  Commitment ID:    ${data.commitment.commitment_id}`);
  lines.push(`  Client:           ${data.commitment.client_name ?? data.commitment.client_id}`);
  lines.push(`  Window Type:      ${data.commitment.window_type}`);
  lines.push(`  Rolling Window:   ${data.commitment.rolling_window_weeks} weeks`);
  lines.push(`  Hard Minimum:     ${data.commitment.hard_minimum ? "Yes" : "No"}`);
  lines.push(`  Proof Required:   ${data.commitment.proof_required ? "Yes" : "No"}`);
  lines.push("");
  lines.push(thinDivider);
  lines.push("  COMPLIANCE SUMMARY");
  lines.push(thinDivider);
  lines.push("");
  lines.push(`  Window Start:     ${data.window_start}`);
  lines.push(`  Window End:       ${data.window_end}`);
  lines.push(`  Target Hours:     ${data.commitment.target_hours}`);
  lines.push(`  Actual Hours:     ${data.actual_hours}`);
  lines.push(`  Status:           ${data.status.toUpperCase()}`);
  lines.push("");
  lines.push(thinDivider);
  lines.push(`  EVENT DETAIL (${data.events.length} events)`);
  lines.push(thinDivider);
  lines.push("");

  if (data.events.length === 0) {
    lines.push("  No events found in this window.");
  } else {
    for (const event of data.events) {
      lines.push(`  ${event.canonical_event_id}`);
      lines.push(`    Title:     ${event.title ?? "(untitled)"}`);
      lines.push(`    Start:     ${event.start_ts}`);
      lines.push(`    End:       ${event.end_ts}`);
      lines.push(`    Hours:     ${event.hours}`);
      lines.push(`    Category:  ${event.billing_category}`);
      lines.push("");
    }
  }

  lines.push(divider);
  lines.push("  CRYPTOGRAPHIC VERIFICATION");
  lines.push(divider);
  lines.push("");
  lines.push(`  SHA-256 Proof Hash: ${proofHash}`);
  lines.push("");
  lines.push("  To verify: compute SHA-256 of the canonical JSON representation");
  lines.push("  of the commitment data (commitment + window + events).");
  lines.push("");
  lines.push(`  Generated: ${new Date().toISOString()}`);
  lines.push(divider);

  return lines.join("\n");
}

/**
 * Generate an HTML proof document suitable for browser Print-to-PDF.
 *
 * Contains: client name, window, target/actual hours, event-level breakdown,
 * proof hash, and HMAC signature. The HTML is self-contained with inline
 * styles for clean rendering.
 */
export function generateProofHtml(
  data: CommitmentProofData,
  proofHash: string,
  signature?: string,
): string {
  const clientDisplay = data.commitment.client_name ?? data.commitment.client_id;
  const statusUpper = data.status.toUpperCase();

  // Build event rows
  let eventRows = "";
  if (data.events.length === 0) {
    eventRows = `<tr><td colspan="6" style="text-align:center;color:#888;">No events found in this window.</td></tr>`;
  } else {
    for (const event of data.events) {
      eventRows += `<tr>
        <td>${escapeHtml(event.canonical_event_id)}</td>
        <td>${escapeHtml(event.title ?? "(untitled)")}</td>
        <td>${escapeHtml(event.start_ts)}</td>
        <td>${escapeHtml(event.end_ts)}</td>
        <td style="text-align:right;">${event.hours}</td>
        <td>${escapeHtml(event.billing_category)}</td>
      </tr>`;
    }
  }

  const signatureSection = signature
    ? `<tr><td><strong>HMAC-SHA256 Signature</strong></td><td style="font-family:monospace;word-break:break-all;">${escapeHtml(signature)}</td></tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Commitment Proof - ${escapeHtml(data.commitment.commitment_id)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 2rem; color: #1a1a1a; }
    h1 { font-size: 1.5rem; border-bottom: 2px solid #333; padding-bottom: 0.5rem; }
    h2 { font-size: 1.2rem; margin-top: 2rem; border-bottom: 1px solid #ccc; padding-bottom: 0.3rem; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; font-size: 0.9rem; }
    th { background-color: #f5f5f5; }
    .meta-table { border: none; }
    .meta-table td { border: none; padding: 0.25rem 0.5rem; }
    .status { font-weight: bold; }
    .status.compliant { color: #2e7d32; }
    .status.under { color: #c62828; }
    .status.over { color: #1565c0; }
    .hash { font-family: monospace; word-break: break-all; font-size: 0.85rem; }
    @media print { body { margin: 1cm; } }
  </style>
</head>
<body>
  <h1>Commitment Proof Document</h1>

  <h2>Commitment Details</h2>
  <table class="meta-table">
    <tr><td><strong>Commitment ID</strong></td><td>${escapeHtml(data.commitment.commitment_id)}</td></tr>
    <tr><td><strong>Client</strong></td><td>${escapeHtml(clientDisplay)}</td></tr>
    <tr><td><strong>Window Type</strong></td><td>${escapeHtml(data.commitment.window_type)}</td></tr>
    <tr><td><strong>Rolling Window</strong></td><td>${data.commitment.rolling_window_weeks} weeks</td></tr>
    <tr><td><strong>Hard Minimum</strong></td><td>${data.commitment.hard_minimum ? "Yes" : "No"}</td></tr>
    <tr><td><strong>Proof Required</strong></td><td>${data.commitment.proof_required ? "Yes" : "No"}</td></tr>
  </table>

  <h2>Compliance Summary</h2>
  <table class="meta-table">
    <tr><td><strong>Window Start</strong></td><td>${escapeHtml(data.window_start)}</td></tr>
    <tr><td><strong>Window End</strong></td><td>${escapeHtml(data.window_end)}</td></tr>
    <tr><td><strong>Target Hours</strong></td><td>${data.commitment.target_hours}</td></tr>
    <tr><td><strong>Actual Hours</strong></td><td>${data.actual_hours}</td></tr>
    <tr><td><strong>Status</strong></td><td class="status ${data.status}">${statusUpper}</td></tr>
  </table>

  <h2>Event Detail (${data.events.length} events)</h2>
  <table>
    <thead>
      <tr>
        <th>Event ID</th>
        <th>Title</th>
        <th>Start</th>
        <th>End</th>
        <th>Hours</th>
        <th>Category</th>
      </tr>
    </thead>
    <tbody>
      ${eventRows}
    </tbody>
  </table>

  <h2>Cryptographic Verification</h2>
  <table class="meta-table">
    <tr><td><strong>SHA-256 Proof Hash</strong></td><td class="hash">${escapeHtml(proofHash)}</td></tr>
    ${signatureSection}
  </table>
  <p style="font-size:0.85rem;color:#666;">
    To verify: compute SHA-256 of the canonical JSON representation of the commitment data
    (commitment + window + events), then verify the HMAC-SHA256 signature using the system key.
  </p>
  <p style="font-size:0.85rem;color:#888;">Generated: ${new Date().toISOString()}</p>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Cryptographic proof signing and verification
// ---------------------------------------------------------------------------

/**
 * Encode a Uint8Array to hex string. Same logic as in deletion-certificate.ts
 * but kept local to avoid cross-module coupling for this self-contained feature.
 */
function bytesToHex(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (const byte of bytes) {
    parts.push(byte.toString(16).padStart(2, "0"));
  }
  return parts.join("");
}

/** Convert a hex string to Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Compute HMAC-SHA256 signature for a commitment proof.
 *
 * Signature = HMAC-SHA256(proof_hash + commitment_id + window, MASTER_KEY)
 *
 * The signing input concatenates proof_hash, commitment_id, and window
 * (start..end) to bind the signature to the specific proof and context.
 *
 * @param proofHash - SHA-256 hash of the canonical proof data
 * @param commitmentId - The commitment ID
 * @param windowStart - Window start timestamp
 * @param windowEnd - Window end timestamp
 * @param masterKey - MASTER_KEY secret for HMAC signing
 * @returns Hex-encoded HMAC-SHA256 signature
 */
export async function computeProofSignature(
  proofHash: string,
  commitmentId: string,
  windowStart: string,
  windowEnd: string,
  masterKey: string,
): Promise<string> {
  const signingInput = `${proofHash}${commitmentId}${windowStart}..${windowEnd}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const encoded = new TextEncoder().encode(signingInput);
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoded);
  return bytesToHex(new Uint8Array(signatureBuffer));
}

/**
 * Verify a commitment proof signature using Web Crypto (constant-time).
 *
 * Re-computes the signing input and uses crypto.subtle.verify for
 * timing-safe comparison.
 *
 * @returns true if the signature is valid, false otherwise.
 */
export async function verifyProofSignature(
  proofHash: string,
  commitmentId: string,
  windowStart: string,
  windowEnd: string,
  signature: string,
  masterKey: string,
): Promise<boolean> {
  try {
    const signingInput = `${proofHash}${commitmentId}${windowStart}..${windowEnd}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(masterKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signatureBytes = hexToBytes(signature);
    const encoded = new TextEncoder().encode(signingInput);
    return crypto.subtle.verify("HMAC", key, signatureBytes, encoded);
  } catch {
    return false;
  }
}
