#!/usr/bin/env node

/**
 * dns-setup.mjs -- Ensure DNS records exist for T-Minus worker routes.
 *
 * Creates proxied CNAME records for all worker subdomains on tminus.ink.
 * Cloudflare Workers custom domain routing requires a proxied DNS record;
 * when proxied, the CNAME target is irrelevant since traffic is routed
 * through Cloudflare to the matched Worker route.
 *
 * Subdomains (production): api, app, mcp, webhooks, oauth
 * Subdomains (staging):    api-staging, app-staging, mcp-staging,
 *                          webhooks-staging, oauth-staging
 *
 * Usage:
 *   node scripts/dns-setup.mjs [options]
 *
 * Options:
 *   --dry-run       Print what would be done without executing
 *   --verbose, -v   Verbose output
 *   --env <name>    Environment: "production" (default), "staging", or "all"
 *
 * Environment:
 *   CLOUDFLARE_API_TOKEN  -- API token with DNS edit permissions
 *   TMINUS_ZONE_ID        -- Zone ID for tminus.ink (from Cloudflare dashboard)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * CNAME target for proxied Worker routes. When Cloudflare proxies the record,
 * actual traffic goes to the Worker -- the CNAME target is never contacted.
 * Pointing at the zone apex is a clean convention for CF Workers.
 */
export const CNAME_TARGET = "tminus.ink";

/**
 * The five service subdomains that T-Minus exposes.
 */
export const SUBDOMAINS = ["api", "app", "mcp", "webhooks", "oauth"];

/**
 * Build DNS record specifications for a given environment.
 * Each record is a proxied CNAME pointing at the zone apex.
 *
 * @param {"production" | "staging"} environment
 * @returns {Array<{ name: string, type: "CNAME", content: string, proxied: true, ttl: 1, comment: string }>}
 */
export function buildDnsRecords(environment) {
  const suffix = environment === "staging" ? "-staging" : "";
  return SUBDOMAINS.map((sub) => ({
    name: `${sub}${suffix}.tminus.ink`,
    type: "CNAME",
    content: CNAME_TARGET,
    proxied: true,
    ttl: 1, // "Auto" in Cloudflare
    comment: "Managed by T-Minus deploy pipeline",
  }));
}

/**
 * DNS hostnames per environment. Each hostname gets a proxied CNAME record.
 * Derived from SUBDOMAINS for consistency.
 */
export const DNS_RECORDS = {
  production: SUBDOMAINS.map((sub) => `${sub}.tminus.ink`),
  staging: SUBDOMAINS.map((sub) => `${sub}-staging.tminus.ink`),
};

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

export function getAuthHeaders() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    throw new Error(
      "Missing CLOUDFLARE_API_TOKEN. Set in .env and source before running."
    );
  }
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export async function cfRequest(path, init = {}) {
  const res = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    ...init,
    headers: {
      ...getAuthHeaders(),
      ...(init.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    const errors = data?.errors ? JSON.stringify(data.errors) : "";
    throw new Error(
      `Cloudflare API error (${res.status}) ${path} ${errors}`.trim()
    );
  }
  return data;
}

// ---------------------------------------------------------------------------
// DNS record management
// ---------------------------------------------------------------------------

async function getExistingRecord(zoneId, type, name) {
  const query = new URLSearchParams({ type, name }).toString();
  const data = await cfRequest(`/zones/${zoneId}/dns_records?${query}`, {
    method: "GET",
  });
  return data.result?.[0] ?? null;
}

async function createRecord(zoneId, record) {
  const data = await cfRequest(`/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify(record),
  });
  return data.result;
}

async function updateRecord(zoneId, recordId, record) {
  const data = await cfRequest(`/zones/${zoneId}/dns_records/${recordId}`, {
    method: "PUT",
    body: JSON.stringify(record),
  });
  return data.result;
}

async function deleteRecord(zoneId, recordId) {
  await cfRequest(`/zones/${zoneId}/dns_records/${recordId}`, {
    method: "DELETE",
  });
}

/**
 * Ensure a proxied CNAME record exists for a Worker hostname.
 * Idempotent: creates if missing, updates if changed, no-op if correct.
 *
 * Also handles migration from legacy A records: if an existing A record is
 * found for the same hostname, it is deleted and replaced with a CNAME.
 *
 * @param {{ zoneId: string, hostname: string, content?: string }} opts
 * @returns {Promise<{ hostname: string, action: "created" | "updated" | "noop" | "migrated" }>}
 */
export async function ensureProxiedRecord({
  zoneId,
  hostname,
  content = CNAME_TARGET,
}) {
  const desired = {
    type: "CNAME",
    name: hostname,
    content,
    ttl: 1, // "Auto" in Cloudflare
    proxied: true,
    comment: "Managed by T-Minus deploy pipeline",
  };

  // Check for existing CNAME record
  const existing = await getExistingRecord(zoneId, "CNAME", desired.name);
  if (existing) {
    const needsUpdate =
      existing.content !== desired.content ||
      existing.proxied !== desired.proxied ||
      existing.ttl !== desired.ttl;

    if (needsUpdate) {
      await updateRecord(zoneId, existing.id, desired);
      return { hostname, action: "updated" };
    }
    return { hostname, action: "noop" };
  }

  // Check for legacy A record that needs migration to CNAME
  const legacyA = await getExistingRecord(zoneId, "A", desired.name);
  if (legacyA) {
    await deleteRecord(zoneId, legacyA.id);
    await createRecord(zoneId, desired);
    return { hostname, action: "migrated" };
  }

  // No existing record at all -- create fresh
  await createRecord(zoneId, desired);
  return { hostname, action: "created" };
}

/**
 * Ensure all DNS records for a given environment.
 *
 * @param {{ zoneId: string, environment: "production" | "staging" }} opts
 * @returns {Promise<Array<{ hostname: string, action: string }>>}
 */
export async function ensureDnsRecords({ zoneId, environment }) {
  const hostnames = DNS_RECORDS[environment];
  if (!hostnames) {
    throw new Error(
      `Unknown environment: ${environment}. Expected: ${Object.keys(DNS_RECORDS).join(", ")}`
    );
  }

  const results = [];
  for (const hostname of hostnames) {
    // Sequential to avoid Cloudflare API burst limits
    results.push(await ensureProxiedRecord({ zoneId, hostname }));
  }
  return results;
}

/**
 * Ensure DNS records for ALL environments (production + staging).
 *
 * @param {{ zoneId: string }} opts
 * @returns {Promise<Array<{ hostname: string, action: string }>>}
 */
export async function ensureAllDnsRecords({ zoneId }) {
  const results = [];
  for (const env of Object.keys(DNS_RECORDS)) {
    const envResults = await ensureDnsRecords({ zoneId, environment: env });
    results.push(...envResults);
  }
  return results;
}

// ---------------------------------------------------------------------------
// CLI argument parsing (pure, testable)
// ---------------------------------------------------------------------------

/**
 * Valid environment names for DNS setup.
 */
export const VALID_ENVIRONMENTS = ["production", "staging", "all"];

export function parseDnsArgs(argv) {
  const args = {
    dryRun: false,
    verbose: false,
    environment: "production",
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--verbose" || argv[i] === "-v") args.verbose = true;
    else if (argv[i] === "--env" && i + 1 < argv.length) {
      args.environment = argv[++i];
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Build the list of DNS record specs that will be created/ensured.
 * Supports "production", "staging", or "all".
 *
 * @param {string} environment
 * @returns {Array<{ name: string, type: string, content: string, proxied: boolean, ttl: number, comment: string }>}
 */
export function getRecordsForEnvironment(environment) {
  if (environment === "all") {
    return [
      ...buildDnsRecords("production"),
      ...buildDnsRecords("staging"),
    ];
  }
  if (!DNS_RECORDS[environment]) {
    throw new Error(
      `Unknown environment: ${environment}. Expected: ${VALID_ENVIRONMENTS.join(", ")}`
    );
  }
  return buildDnsRecords(environment);
}

async function main() {
  const args = parseDnsArgs(process.argv.slice(2));

  if (!VALID_ENVIRONMENTS.includes(args.environment)) {
    throw new Error(
      `Unknown environment: ${args.environment}. Expected: ${VALID_ENVIRONMENTS.join(", ")}`
    );
  }

  const zoneId = process.env.TMINUS_ZONE_ID;
  if (!zoneId) {
    throw new Error(
      "Missing TMINUS_ZONE_ID. Set in .env (Cloudflare zone ID for tminus.ink)."
    );
  }

  const records = getRecordsForEnvironment(args.environment);

  process.stdout.write(`[dns-setup] Environment: ${args.environment}\n`);
  process.stdout.write(`[dns-setup] Zone ID: ${zoneId}\n`);
  process.stdout.write(
    `[dns-setup] Records (${records.length}): ${records.map((r) => r.name).join(", ")}\n\n`
  );

  if (args.dryRun) {
    for (const record of records) {
      process.stdout.write(
        `[dns-setup] [dry-run] Would ensure proxied CNAME: ${record.name} -> ${record.content}\n`
      );
    }
    process.stdout.write("\n[dns-setup] Dry run complete.\n");
    return;
  }

  let results;
  if (args.environment === "all") {
    results = await ensureAllDnsRecords({ zoneId });
  } else {
    results = await ensureDnsRecords({ zoneId, environment: args.environment });
  }

  for (const { hostname, action } of results) {
    process.stdout.write(`[dns-setup] ${hostname}: ${action}\n`);
  }

  process.stdout.write("\n[dns-setup] DNS setup complete.\n");
}

// Only run main when executed directly (not when imported for testing)
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("dns-setup.mjs") ||
    process.argv[1].endsWith("dns-setup"));

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`\n[dns-setup] ERROR: ${err.message}\n`);
    process.exit(1);
  });
}
