/**
 * Route group: Commitments + Simulation + Proofs (Premium+).
 */

import { isValidId, generateId } from "@tminus/shared";
import type { CanonicalEvent, SimulationScenario, ImpactReport } from "@tminus/shared";
import { enforceFeatureGate } from "../../middleware/feature-gate";
import {
  type RouteGroupHandler,
  type AuthContext,
  matchRoute,
  callDO,
  parseJsonBody,
  jsonResponse,
  successEnvelope,
  errorEnvelope,
  ErrorCode,
} from "../shared";

// ---------------------------------------------------------------------------
// Commitment CRUD handlers
// ---------------------------------------------------------------------------

async function handleCreateCommitment(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{
    client_id?: string;
    target_hours?: number;
    window_type?: string;
    client_name?: string;
    rolling_window_weeks?: number;
    hard_minimum?: boolean;
    proof_required?: boolean;
  }>(request);

  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!body.client_id || typeof body.client_id !== "string") {
    return jsonResponse(
      errorEnvelope("client_id is required", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (body.target_hours === undefined || typeof body.target_hours !== "number" || body.target_hours <= 0) {
    return jsonResponse(
      errorEnvelope("target_hours is required and must be a positive number", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (body.window_type !== undefined) {
    const validWindowTypes = ["WEEKLY", "MONTHLY"];
    if (!validWindowTypes.includes(body.window_type)) {
      return jsonResponse(
        errorEnvelope(
          `Invalid window_type: ${body.window_type}. Must be one of: ${validWindowTypes.join(", ")}`,
          "VALIDATION_ERROR",
        ),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  if (body.rolling_window_weeks !== undefined) {
    if (typeof body.rolling_window_weeks !== "number" || body.rolling_window_weeks < 1 || !Number.isInteger(body.rolling_window_weeks)) {
      return jsonResponse(
        errorEnvelope("rolling_window_weeks must be a positive integer", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  try {
    const commitmentId = generateId("commitment");
    const result = await callDO<{
      commitment_id: string;
      client_id: string;
      client_name: string | null;
      window_type: string;
      target_hours: number;
      rolling_window_weeks: number;
      hard_minimum: boolean;
      proof_required: boolean;
      created_at: string;
    }>(env.USER_GRAPH, auth.userId, "/createCommitment", {
      commitment_id: commitmentId,
      client_id: body.client_id,
      target_hours: body.target_hours,
      window_type: body.window_type ?? "WEEKLY",
      client_name: body.client_name ?? null,
      rolling_window_weeks: body.rolling_window_weeks ?? 4,
      hard_minimum: body.hard_minimum ?? false,
      proof_required: body.proof_required ?? false,
    });

    if (!result.ok) {
      const errorData = result.data as { error?: string };
      const errorMsg = errorData.error ?? "Failed to create commitment";
      if (errorMsg.includes("already exists")) {
        return jsonResponse(
          errorEnvelope(errorMsg, "CONFLICT"),
          ErrorCode.CONFLICT,
        );
      }
      return jsonResponse(
        errorEnvelope(errorMsg, "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 201);
  } catch (err) {
    console.error("Failed to create commitment", err);
    return jsonResponse(
      errorEnvelope("Failed to create commitment", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleListCommitments(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const result = await callDO<{ items: unknown[] }>(
      env.USER_GRAPH,
      auth.userId,
      "/listCommitments",
      {},
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to list commitments", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data.items), 200);
  } catch (err) {
    console.error("Failed to list commitments", err);
    return jsonResponse(
      errorEnvelope("Failed to list commitments", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleGetCommitmentStatus(
  _request: Request,
  auth: AuthContext,
  env: Env,
  commitmentId: string,
): Promise<Response> {
  if (!isValidId(commitmentId, "commitment")) {
    return jsonResponse(
      errorEnvelope("Invalid commitment ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{
      commitment_id: string;
      client_id: string;
      client_name: string | null;
      window_type: string;
      target_hours: number;
      actual_hours: number;
      status: string;
      window_start: string;
      window_end: string;
      rolling_window_weeks: number;
    } | null>(env.USER_GRAPH, auth.userId, "/getCommitmentStatus", {
      commitment_id: commitmentId,
    });

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to get commitment status", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (result.data === null) {
      return jsonResponse(
        errorEnvelope("Commitment not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to get commitment status", err);
    return jsonResponse(
      errorEnvelope("Failed to get commitment status", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleDeleteCommitment(
  _request: Request,
  auth: AuthContext,
  env: Env,
  commitmentId: string,
): Promise<Response> {
  if (!isValidId(commitmentId, "commitment")) {
    return jsonResponse(
      errorEnvelope("Invalid commitment ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{ deleted: boolean }>(
      env.USER_GRAPH,
      auth.userId,
      "/deleteCommitment",
      { commitment_id: commitmentId },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to delete commitment", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (!result.data.deleted) {
      return jsonResponse(
        errorEnvelope("Commitment not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope({ deleted: true }), 200);
  } catch (err) {
    console.error("Failed to delete commitment", err);
    return jsonResponse(
      errorEnvelope("Failed to delete commitment", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Proof infrastructure (types, hashing, generation, signatures)
// ---------------------------------------------------------------------------

// -- Commitment Proof Export --------------------------------------------------

/**
 * Shape of the proof data returned by the UserGraphDO.
 * Matches CommitmentProofData from the DO module.
 */
interface ProofEvent {
  canonical_event_id: string;
  title: string | null;
  start_ts: string;
  end_ts: string;
  hours: number;
  billing_category: string;
}

interface CommitmentProofData {
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

/** Escape a string for CSV (wrap in quotes if it contains comma, quote, or newline). */
function csvEscape(str: string): string {
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
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

/** Seven years in seconds, used for R2 object retention. */
const SEVEN_YEARS_SECONDS = 7 * 365 * 24 * 60 * 60; // 220,752,000

// ---------------------------------------------------------------------------
// Export commitment proof handler
// ---------------------------------------------------------------------------

async function handleExportCommitmentProof(
  request: Request,
  auth: AuthContext,
  env: Env,
  commitmentId: string,
): Promise<Response> {
  if (!isValidId(commitmentId, "commitment")) {
    return jsonResponse(
      errorEnvelope("Invalid commitment ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!env.PROOF_BUCKET) {
    return jsonResponse(
      errorEnvelope("Proof export not configured (R2 bucket missing)", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }

  if (!env.MASTER_KEY) {
    return jsonResponse(
      errorEnvelope("Proof signing not configured (MASTER_KEY missing)", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }

  // Parse optional body for format
  let format: "pdf" | "csv" = "pdf";
  try {
    const body = await parseJsonBody<{ format?: string }>(request);
    if (body?.format) {
      if (body.format !== "pdf" && body.format !== "csv") {
        return jsonResponse(
          errorEnvelope("format must be 'pdf' or 'csv'", "VALIDATION_ERROR"),
          ErrorCode.VALIDATION_ERROR,
        );
      }
      format = body.format;
    }
  } catch {
    // No body or invalid JSON -- use default format
  }

  try {
    // Get proof data from DO
    const result = await callDO<CommitmentProofData | null>(
      env.USER_GRAPH,
      auth.userId,
      "/getCommitmentProofData",
      { commitment_id: commitmentId },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to get commitment proof data", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (result.data === null) {
      return jsonResponse(
        errorEnvelope("Commitment not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    const proofData = result.data;

    // Compute SHA-256 proof hash
    const proofHash = await computeProofHash(proofData);

    // Compute HMAC-SHA256 signature: sign(proof_hash + commitment_id + window, MASTER_KEY)
    const signature = await computeProofSignature(
      proofHash,
      commitmentId,
      proofData.window_start,
      proofData.window_end,
      env.MASTER_KEY,
    );

    const signedAt = new Date().toISOString();
    const proofId = generateId("proof");

    // Generate document content
    let content: string;
    let contentType: string;
    let fileExtension: string;

    if (format === "csv") {
      content = generateProofCsv(proofData, proofHash);
      contentType = "text/csv";
      fileExtension = "csv";
    } else {
      // HTML document for browser Print-to-PDF
      content = generateProofHtml(proofData, proofHash, signature);
      contentType = "text/html";
      fileExtension = "html";
    }

    // Build R2 key: proofs/{userId}/{commitmentId}/{window}.{ext}
    const windowKey = `${proofData.window_start}_${proofData.window_end}`.replace(/[:.]/g, "-");
    const r2Key = `proofs/${auth.userId}/${commitmentId}/${windowKey}.${fileExtension}`;

    // Store in R2 with 7-year retention metadata for compliance (NFR-27)
    const retentionExpiry = new Date(Date.now() + SEVEN_YEARS_SECONDS * 1000).toISOString();
    await env.PROOF_BUCKET.put(r2Key, content, {
      httpMetadata: {
        contentType,
        contentDisposition: `attachment; filename="commitment-proof-${commitmentId}.${fileExtension}"`,
      },
      customMetadata: {
        proof_id: proofId,
        commitment_id: commitmentId,
        user_id: auth.userId,
        proof_hash: proofHash,
        signature,
        signed_at: signedAt,
        format,
        generated_at: signedAt,
        retention_policy: "7_years",
        retention_expiry: retentionExpiry,
        window_start: proofData.window_start,
        window_end: proofData.window_end,
      },
    });

    // Build download URL
    const downloadUrl = `/v1/proofs/${encodeURIComponent(r2Key)}`;

    return jsonResponse(
      successEnvelope({
        proof_id: proofId,
        download_url: downloadUrl,
        proof_hash: proofHash,
        signature,
        signed_at: signedAt,
        format,
        r2_key: r2Key,
        commitment_id: commitmentId,
        actual_hours: proofData.actual_hours,
        target_hours: proofData.commitment.target_hours,
        status: proofData.status,
        event_count: proofData.events.length,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to export commitment proof", err);
    return jsonResponse(
      errorEnvelope("Failed to export commitment proof", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Simulation handler
// ---------------------------------------------------------------------------

async function handleSimulation(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{
    scenario?: {
      type?: string;
      client_id?: string;
      hours_per_week?: number;
      title?: string;
      day_of_week?: number;
      start_time?: number;
      end_time?: number;
      duration_weeks?: number;
      start_hour?: number;
      end_hour?: number;
    };
  }>(request);

  if (!body || !body.scenario) {
    return jsonResponse(
      errorEnvelope("Request body must include a scenario object", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const { scenario } = body;

  if (!scenario.type) {
    return jsonResponse(
      errorEnvelope("scenario.type is required", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const validTypes = ["add_commitment", "add_recurring_event", "change_working_hours"];
  if (!validTypes.includes(scenario.type)) {
    return jsonResponse(
      errorEnvelope(
        `Invalid scenario.type: ${scenario.type}. Must be one of: ${validTypes.join(", ")}`,
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Type-specific validation
  if (scenario.type === "add_commitment") {
    if (!scenario.client_id || typeof scenario.client_id !== "string") {
      return jsonResponse(
        errorEnvelope("scenario.client_id is required for add_commitment", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.hours_per_week === undefined || typeof scenario.hours_per_week !== "number" || scenario.hours_per_week < 0) {
      return jsonResponse(
        errorEnvelope("scenario.hours_per_week is required and must be a non-negative number", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  if (scenario.type === "add_recurring_event") {
    if (!scenario.title || typeof scenario.title !== "string") {
      return jsonResponse(
        errorEnvelope("scenario.title is required for add_recurring_event", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.day_of_week === undefined || typeof scenario.day_of_week !== "number" || scenario.day_of_week < 0 || scenario.day_of_week > 6) {
      return jsonResponse(
        errorEnvelope("scenario.day_of_week must be 0-6 (Monday-Sunday)", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.start_time === undefined || typeof scenario.start_time !== "number") {
      return jsonResponse(
        errorEnvelope("scenario.start_time is required (decimal hour, e.g. 14 for 2pm)", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.end_time === undefined || typeof scenario.end_time !== "number") {
      return jsonResponse(
        errorEnvelope("scenario.end_time is required (decimal hour)", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.duration_weeks === undefined || typeof scenario.duration_weeks !== "number" || scenario.duration_weeks < 1) {
      return jsonResponse(
        errorEnvelope("scenario.duration_weeks must be a positive integer", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  if (scenario.type === "change_working_hours") {
    if (scenario.start_hour === undefined || typeof scenario.start_hour !== "number") {
      return jsonResponse(
        errorEnvelope("scenario.start_hour is required for change_working_hours", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.end_hour === undefined || typeof scenario.end_hour !== "number") {
      return jsonResponse(
        errorEnvelope("scenario.end_hour is required for change_working_hours", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.start_hour >= scenario.end_hour) {
      return jsonResponse(
        errorEnvelope("scenario.start_hour must be less than scenario.end_hour", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  try {
    const result = await callDO<ImpactReport>(
      env.USER_GRAPH,
      auth.userId,
      "/simulate",
      { scenario: scenario as SimulationScenario },
    );

    if (!result.ok) {
      const errorData = result.data as unknown as { error?: string };
      return jsonResponse(
        errorEnvelope(errorData.error ?? "Simulation failed", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Simulation failed", err);
    return jsonResponse(
      errorEnvelope("Simulation failed", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Proof download and verification handlers
// ---------------------------------------------------------------------------

async function handleDownloadProof(
  _request: Request,
  auth: AuthContext,
  env: Env,
  r2Key: string,
): Promise<Response> {
  if (!env.PROOF_BUCKET) {
    return jsonResponse(
      errorEnvelope("Proof export not configured", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }

  // Security: verify the proof belongs to this user
  if (!r2Key.startsWith(`proofs/${auth.userId}/`)) {
    return jsonResponse(
      errorEnvelope("Proof not found", "NOT_FOUND"),
      ErrorCode.NOT_FOUND,
    );
  }

  try {
    const object = await env.PROOF_BUCKET.get(r2Key);
    if (!object) {
      return jsonResponse(
        errorEnvelope("Proof not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);

    return new Response(object.body, { headers });
  } catch (err) {
    console.error("Failed to download proof", err);
    return jsonResponse(
      errorEnvelope("Failed to download proof", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

/**
 * GET /v1/proofs/:proof_id/verify
 *
 * Verify a proof document's cryptographic signature.
 * Looks up the proof metadata in R2 by proof_id (stored in customMetadata),
 * then re-verifies the HMAC-SHA256 signature.
 *
 * Response: { valid: boolean, proof_hash: string, signed_at: string }
 */
async function handleVerifyProof(
  _request: Request,
  auth: AuthContext,
  env: Env,
  proofId: string,
): Promise<Response> {
  // Validate input first, before checking env bindings
  if (!proofId || !proofId.startsWith("prf_")) {
    return jsonResponse(
      errorEnvelope("Invalid proof ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!env.PROOF_BUCKET) {
    return jsonResponse(
      errorEnvelope("Proof export not configured", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }

  if (!env.MASTER_KEY) {
    return jsonResponse(
      errorEnvelope("Proof verification not configured", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }

  try {
    // List objects in user's proof directory to find the one with matching proof_id
    const prefix = `proofs/${auth.userId}/`;
    const listed = await env.PROOF_BUCKET.list({ prefix, limit: 500 });

    let foundObject: R2Object | null = null;
    for (const obj of listed.objects) {
      if (obj.customMetadata?.proof_id === proofId) {
        foundObject = obj;
        break;
      }
    }

    if (!foundObject) {
      return jsonResponse(
        errorEnvelope("Proof not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    const meta = foundObject.customMetadata ?? {};
    const proofHash = meta.proof_hash;
    const storedSignature = meta.signature;
    const signedAt = meta.signed_at;
    const commitmentId = meta.commitment_id;
    const windowStart = meta.window_start;
    const windowEnd = meta.window_end;

    if (!proofHash || !storedSignature || !commitmentId || !windowStart || !windowEnd) {
      return jsonResponse(
        successEnvelope({
          valid: false,
          proof_hash: proofHash ?? null,
          signed_at: signedAt ?? null,
          reason: "Incomplete proof metadata",
        }),
        200,
      );
    }

    // Re-verify the HMAC-SHA256 signature using Web Crypto (constant-time)
    const valid = await verifyProofSignature(
      proofHash,
      commitmentId,
      windowStart,
      windowEnd,
      storedSignature,
      env.MASTER_KEY,
    );

    return jsonResponse(
      successEnvelope({
        valid,
        proof_hash: proofHash,
        signed_at: signedAt ?? null,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to verify proof", err);
    return jsonResponse(
      errorEnvelope("Failed to verify proof", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Route group: Commitments
// ---------------------------------------------------------------------------

export const routeCommitmentRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  if (method === "POST" && pathname === "/v1/commitments") {
    const commitGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
    if (commitGate) return commitGate;
    return handleCreateCommitment(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/commitments") {
    return handleListCommitments(request, auth, env);
  }

  let match = matchRoute(pathname, "/v1/commitments/:id/status");
  if (match && method === "GET") {
    return handleGetCommitmentStatus(request, auth, env, match.params[0]);
  }

  match = matchRoute(pathname, "/v1/commitments/:id/export");
  if (match && method === "POST") {
    const exportGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
    if (exportGate) return exportGate;
    return handleExportCommitmentProof(request, auth, env, match.params[0]);
  }

  match = matchRoute(pathname, "/v1/commitments/:id");
  if (match && method === "DELETE") {
    const commitDeleteGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
    if (commitDeleteGate) return commitDeleteGate;
    return handleDeleteCommitment(request, auth, env, match.params[0]);
  }

  // -- What-If Simulation route (Premium+) --

  if (method === "POST" && pathname === "/v1/simulation") {
    const simGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
    if (simGate) return simGate;
    return handleSimulation(request, auth, env);
  }

  // -- Proof verification and download routes --

  match = matchRoute(pathname, "/v1/proofs/:id/verify");
  if (match && method === "GET") {
    return handleVerifyProof(request, auth, env, match.params[0]);
  }

  if (method === "GET" && pathname.startsWith("/v1/proofs/")) {
    const r2Key = decodeURIComponent(pathname.slice("/v1/proofs/".length));
    return handleDownloadProof(request, auth, env, r2Key);
  }

  return null;
};

