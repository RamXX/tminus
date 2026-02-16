/**
 * Organization domain-wide delegation route handlers (TM-9iu.1).
 *
 * Provides Workspace admin delegation registration and user impersonation:
 *   POST   /v1/orgs/register       - Register org with domain-wide delegation
 *   GET    /v1/orgs/delegation/calendars/:email - Fetch calendars for a delegated user
 *
 * Design:
 * - Service account credentials encrypted with AES-256-GCM (AD-2)
 * - Delegation validated before accepting registration
 * - Users in registered domains get calendar access without personal OAuth
 * - All data access goes through DelegationStore (no raw SQL)
 */

import {
  generateId,
  validateServiceAccountKey,
  getImpersonationToken,
  encryptServiceAccountKey,
  decryptServiceAccountKey,
  importMasterKeyForServiceAccount,
  GoogleCalendarClient,
  DELEGATION_SCOPES,
} from "@tminus/shared";
import type {
  ServiceAccountKey,
  CalendarListEntry,
  FetchFn,
  DelegationStore,
  DelegationRecord,
} from "@tminus/shared";
import {
  type AuthContext,
  successEnvelope,
  errorEnvelope,
  jsonResponse,
  parseJsonBody,
} from "./shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DelegationEnv {
  store: DelegationStore;
  /** Hex-encoded 32-byte master key for encryption (AD-2). */
  MASTER_KEY?: string;
}

// ---------------------------------------------------------------------------
// Validation helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Validate org registration input.
 * Returns error string or null if valid.
 */
export function validateOrgRegistration(body: Record<string, unknown>): string | null {
  if (!body.domain || typeof body.domain !== "string") {
    return "domain is required and must be a string";
  }
  if (!body.admin_email || typeof body.admin_email !== "string") {
    return "admin_email is required and must be a string";
  }

  // Domain must look like a domain (basic check)
  const domain = body.domain as string;
  if (!domain.includes(".") || domain.length < 4) {
    return "domain must be a valid domain name (e.g., example.com)";
  }

  // Admin email must be in the same domain
  const email = body.admin_email as string;
  if (!email.includes("@")) {
    return "admin_email must be a valid email address";
  }
  const emailDomain = email.split("@")[1];
  if (emailDomain !== domain) {
    return "admin_email must be in the same domain as the organization";
  }

  // Service account key must be present
  if (!body.service_account_key) {
    return "service_account_key is required (Google service account JSON key)";
  }

  // Validate service account key shape
  const saKeyError = validateServiceAccountKey(body.service_account_key);
  if (saKeyError) {
    return saKeyError;
  }

  return null;
}

/**
 * Extract the email domain from an email address.
 * Returns null if the email is invalid.
 */
export function extractEmailDomain(email: string): string | null {
  if (!email || !email.includes("@")) return null;
  return email.split("@")[1].toLowerCase();
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /v1/orgs/register -- Register an org with domain-wide delegation.
 *
 * Body: {
 *   domain: string,
 *   admin_email: string,
 *   service_account_key: ServiceAccountKey
 * }
 *
 * Validates delegation by attempting a test API call impersonating the admin.
 * On success, creates org delegation record with encrypted credentials.
 */
export async function handleOrgRegister(
  request: Request,
  _auth: AuthContext,
  env: DelegationEnv,
  fetchFn?: FetchFn,
): Promise<Response> {
  const body = await parseJsonBody<Record<string, unknown>>(request);
  if (!body) {
    return jsonResponse(errorEnvelope("Request body must be valid JSON"), 400);
  }

  const inputError = validateOrgRegistration(body);
  if (inputError) {
    return jsonResponse(errorEnvelope(inputError), 400);
  }

  if (!env.MASTER_KEY) {
    return jsonResponse(
      errorEnvelope("Delegation service not configured (missing MASTER_KEY)"),
      500,
    );
  }

  const domain = (body.domain as string).toLowerCase();
  const adminEmail = body.admin_email as string;
  const serviceAccountKey = body.service_account_key as ServiceAccountKey;

  // Check if domain is already registered (via DelegationStore)
  const existing = await env.store.getDelegation(domain);

  if (existing) {
    return jsonResponse(
      errorEnvelope(`Domain '${domain}' is already registered for delegation`),
      409,
    );
  }

  // Validate delegation by attempting to impersonate the admin
  try {
    const accessToken = await getImpersonationToken(
      serviceAccountKey,
      adminEmail,
      DELEGATION_SCOPES,
      fetchFn,
    );

    // Try to list calendars to verify access works
    const client = new GoogleCalendarClient(accessToken, fetchFn);
    const calendars = await client.listCalendars();

    if (!calendars || calendars.length === 0) {
      return jsonResponse(
        errorEnvelope("Delegation validation succeeded but no calendars found for admin"),
        422,
      );
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return jsonResponse(
      errorEnvelope(`Delegation validation failed: ${errMsg}. Please verify domain-wide delegation is configured in Google Admin Console.`),
      422,
    );
  }

  // Encrypt the service account key (AD-2)
  const masterKey = await importMasterKeyForServiceAccount(env.MASTER_KEY);
  const encryptedKey = await encryptServiceAccountKey(masterKey, serviceAccountKey);

  // Store the delegation record (via DelegationStore)
  const delegationId = generateId("delegation");
  const now = new Date().toISOString();

  const record: DelegationRecord = {
    delegationId,
    domain,
    adminEmail,
    delegationStatus: "active",
    encryptedSaKey: JSON.stringify(encryptedKey),
    saClientEmail: serviceAccountKey.client_email,
    saClientId: serviceAccountKey.client_id,
    validatedAt: now,
    activeUsersCount: 0,
    registrationDate: now,
    saKeyCreatedAt: now,
    saKeyLastUsedAt: null,
    saKeyRotationDueAt: null,
    previousEncryptedSaKey: null,
    previousSaKeyId: null,
    lastHealthCheckAt: null,
    healthCheckStatus: "unknown",
    createdAt: now,
    updatedAt: now,
  };

  try {
    await env.store.createDelegation(record);

    return jsonResponse(
      successEnvelope({
        delegation_id: delegationId,
        domain,
        admin_email: adminEmail,
        delegation_status: "active",
        sa_client_email: serviceAccountKey.client_email,
        sa_client_id: serviceAccountKey.client_id,
        validated_at: now,
        created_at: now,
      }),
      201,
    );
  } catch (err) {
    console.error("Failed to store delegation record", err);
    return jsonResponse(
      errorEnvelope("Failed to register organization delegation"),
      500,
    );
  }
}

/**
 * GET /v1/orgs/delegation/calendars/:email -- Fetch calendars for a delegated user.
 *
 * Detects user's email domain, looks up delegation, impersonates user,
 * and returns their calendar list -- all without any personal OAuth.
 */
export async function handleDelegationCalendars(
  _request: Request,
  _auth: AuthContext,
  env: DelegationEnv,
  email: string,
  fetchFn?: FetchFn,
): Promise<Response> {
  if (!email || !email.includes("@")) {
    return jsonResponse(errorEnvelope("Invalid email address"), 400);
  }

  if (!env.MASTER_KEY) {
    return jsonResponse(
      errorEnvelope("Delegation service not configured (missing MASTER_KEY)"),
      500,
    );
  }

  const domain = extractEmailDomain(email);
  if (!domain) {
    return jsonResponse(errorEnvelope("Could not extract domain from email"), 400);
  }

  // Look up delegation for this domain (via DelegationStore)
  const delegation = await env.store.getDelegation(domain);

  if (!delegation) {
    return jsonResponse(
      errorEnvelope(`No delegation found for domain '${domain}'`),
      404,
    );
  }

  if (delegation.delegationStatus !== "active") {
    return jsonResponse(
      errorEnvelope(`Delegation for domain '${domain}' is ${delegation.delegationStatus}`),
      403,
    );
  }

  // Decrypt the service account key
  let serviceAccountKey: ServiceAccountKey;
  try {
    const masterKey = await importMasterKeyForServiceAccount(env.MASTER_KEY);
    const envelope = JSON.parse(delegation.encryptedSaKey);
    serviceAccountKey = await decryptServiceAccountKey(masterKey, envelope);
  } catch (err) {
    console.error("Failed to decrypt service account key", err);
    return jsonResponse(
      errorEnvelope("Failed to decrypt delegation credentials"),
      500,
    );
  }

  // Impersonate the user and fetch their calendars
  try {
    const accessToken = await getImpersonationToken(
      serviceAccountKey,
      email,
      DELEGATION_SCOPES,
      fetchFn,
    );

    const client = new GoogleCalendarClient(accessToken, fetchFn);
    const calendars = await client.listCalendars();

    return jsonResponse(
      successEnvelope({
        email,
        domain,
        delegation_id: delegation.delegationId,
        calendars: calendars.map((cal: CalendarListEntry) => ({
          id: cal.id,
          summary: cal.summary,
          primary: cal.primary ?? false,
          accessRole: cal.accessRole,
        })),
        source: "delegation",
      }),
      200,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return jsonResponse(
      errorEnvelope(`Failed to fetch calendars for ${email}: ${errMsg}`),
      502,
    );
  }
}
