/**
 * Route group: Commitments + Simulation + Proofs (Premium+).
 *
 * Handler logic is decomposed into sub-modules:
 * - commitments/crud.ts       -- Commitment CRUD (create, list, status, delete)
 * - commitments/proof.ts      -- Proof types, hashing, document generation, signing
 * - commitments/simulation.ts -- What-if simulation handler
 *
 * This file contains the route dispatcher and the proof export/download/verify
 * handlers (which orchestrate across proof sub-module functions).
 */

import { isValidId, generateId } from "@tminus/shared";
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

// Sub-module imports
import {
  handleCreateCommitment,
  handleListCommitments,
  handleGetCommitmentStatus,
  handleDeleteCommitment,
} from "./commitments/crud";

import {
  type CommitmentProofData,
  computeProofHash,
  generateProofCsv,
  generateProofDocument,
  generateProofHtml,
  computeProofSignature,
  verifyProofSignature,
} from "./commitments/proof";

import { handleSimulation } from "./commitments/simulation";

// Re-export proof functions for backward compatibility (tests, index.ts re-exports)
export {
  computeProofHash,
  generateProofCsv,
  generateProofDocument,
  generateProofHtml,
  computeProofSignature,
  verifyProofSignature,
} from "./commitments/proof";

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
