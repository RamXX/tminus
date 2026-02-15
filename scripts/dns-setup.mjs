#!/usr/bin/env node

/**
 * dns-setup.mjs -- Ensure DNS records exist for T-Minus worker routes.
 *
 * Creates proxied A records for worker subdomains on tminus.ink.
 * Workers custom domain routing requires a proxied DNS record pointing
 * at any IP (the actual traffic goes to the Worker, not the IP).
 *
 * Usage:
 *   node scripts/dns-setup.mjs [options]
 *
 * Options:
 *   --dry-run       Print what would be done without executing
 *   --verbose, -v   Verbose output
 *   --env <name>    Environment: "production" (default) or "staging"
 *
 * Environment:
 *   CLOUDFLARE_API_TOKEN  -- API token with DNS edit permissions
 *   TMINUS_ZONE_ID        -- Zone ID for tminus.ink (from Cloudflare dashboard)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

// Reserved IP for proxied Worker routes. When Cloudflare proxies a record,
// traffic goes to the Worker -- the origin IP is never contacted.
// Using 192.0.2.1 (TEST-NET-1, RFC 5737) which is safe for this purpose.
const WORKERS_PLACEHOLDER_IP = "192.0.2.1";

/**
 * DNS hostnames per environment. Each hostname gets a proxied A record.
 */
export const DNS_RECORDS = {
  production: ["api.tminus.ink"],
  staging: ["api-staging.tminus.ink"],
};

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function getAuthHeaders() {
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

async function cfRequest(path, init = {}) {
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

/**
 * Ensure a proxied A record exists for a Worker hostname.
 * Idempotent: creates if missing, updates if changed, no-op if correct.
 *
 * @param {{ zoneId: string, hostname: string, content?: string }} opts
 * @returns {Promise<{ hostname: string, action: "created" | "updated" | "noop" }>}
 */
export async function ensureProxiedRecord({
  zoneId,
  hostname,
  content = WORKERS_PLACEHOLDER_IP,
}) {
  const desired = {
    type: "A",
    name: hostname,
    content,
    ttl: 1, // "Auto" in Cloudflare
    proxied: true,
    comment: "Managed by T-Minus deploy pipeline",
  };

  const existing = await getExistingRecord(zoneId, desired.type, desired.name);
  if (!existing) {
    await createRecord(zoneId, desired);
    return { hostname, action: "created" };
  }

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

/**
 * Ensure all DNS records for a given environment.
 *
 * @param {{ zoneId: string, environment: string }} opts
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
    results.push(await ensureProxiedRecord({ zoneId, hostname }));
  }
  return results;
}

// ---------------------------------------------------------------------------
// CLI argument parsing (pure, testable)
// ---------------------------------------------------------------------------

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

async function main() {
  const args = parseDnsArgs(process.argv.slice(2));

  const zoneId = process.env.TMINUS_ZONE_ID;
  if (!zoneId) {
    throw new Error(
      "Missing TMINUS_ZONE_ID. Set in .env (Cloudflare zone ID for tminus.ink)."
    );
  }

  const hostnames = DNS_RECORDS[args.environment];
  if (!hostnames) {
    throw new Error(
      `Unknown environment: ${args.environment}. Expected: ${Object.keys(DNS_RECORDS).join(", ")}`
    );
  }

  process.stdout.write(`[dns-setup] Environment: ${args.environment}\n`);
  process.stdout.write(`[dns-setup] Zone ID: ${zoneId}\n`);
  process.stdout.write(
    `[dns-setup] Hostnames: ${hostnames.join(", ")}\n\n`
  );

  if (args.dryRun) {
    for (const hostname of hostnames) {
      process.stdout.write(
        `[dns-setup] [dry-run] Would ensure proxied A record: ${hostname} -> ${WORKERS_PLACEHOLDER_IP}\n`
      );
    }
    process.stdout.write("\n[dns-setup] Dry run complete.\n");
    return;
  }

  const results = await ensureDnsRecords({
    zoneId,
    environment: args.environment,
  });

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
