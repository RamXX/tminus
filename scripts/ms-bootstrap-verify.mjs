#!/usr/bin/env node
/**
 * Microsoft Production Bootstrap Verification Script
 * Story: TM-psbd.1
 *
 * Verifies:
 * 1. Required env vars are present (without logging values)
 * 2. MS refresh token -> access token exchange succeeds
 * 3. Microsoft Graph /me resolves to expected identity
 *
 * Usage:
 *   source .env && node scripts/ms-bootstrap-verify.mjs
 *
 * NEVER logs secrets or token values.
 */

const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const EXPECTED_EMAIL = "ramiro@cibertrend.com";

async function main() {
  const timestamp = new Date().toISOString();
  console.log(`\n=== Microsoft Bootstrap Verification ===`);
  console.log(`Timestamp: ${timestamp}`);
  console.log(`Expected identity: ${EXPECTED_EMAIL}\n`);

  // Step 1: Verify env vars
  console.log("--- Step 1: Environment Variable Check ---");
  const required = ["MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_TEST_REFRESH_TOKEN_B", "JWT_SECRET"];
  const missing = [];
  for (const v of required) {
    const val = process.env[v];
    if (!val || val.trim().length === 0) {
      console.log(`  ${v}: MISSING`);
      missing.push(v);
    } else {
      console.log(`  ${v}: SET (length=${val.trim().length})`);
    }
  }
  if (missing.length > 0) {
    console.error(`\nFATAL: Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log("  Result: ALL PRESENT\n");

  // Step 2: Token exchange
  console.log("--- Step 2: Token Exchange (refresh -> access) ---");
  const start2 = Date.now();
  let accessToken;
  try {
    const resp = await fetch(MS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: process.env.MS_CLIENT_ID.trim(),
        client_secret: process.env.MS_CLIENT_SECRET.trim(),
        refresh_token: process.env.MS_TEST_REFRESH_TOKEN_B.trim(),
        scope: "Calendars.ReadWrite User.Read offline_access",
      }),
    });
    const latency2 = Date.now() - start2;

    if (!resp.ok) {
      const body = await resp.text();
      console.error(`  FAILED: HTTP ${resp.status}`);
      // Print error description but NOT any token values
      try {
        const err = JSON.parse(body);
        console.error(`  Error: ${err.error} - ${err.error_description?.split("\n")[0]}`);
      } catch {
        console.error(`  Response body (first 200 chars): ${body.slice(0, 200)}`);
      }
      process.exit(1);
    }

    const data = await resp.json();
    accessToken = data.access_token;
    console.log(`  Result: SUCCESS (${latency2}ms)`);
    console.log(`  Token type: ${data.token_type}`);
    console.log(`  Scope: ${data.scope}`);
    console.log(`  Access token length: ${accessToken?.length || 0}`);
    console.log(`  Expires in: ${data.expires_in}s\n`);
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
    process.exit(1);
  }

  // Step 3: Identity verification via /me
  console.log("--- Step 3: Identity Verification (Graph /me) ---");
  const start3 = Date.now();
  try {
    const resp = await fetch(`${MS_GRAPH_BASE}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const latency3 = Date.now() - start3;

    if (!resp.ok) {
      const body = await resp.text();
      console.error(`  FAILED: HTTP ${resp.status} - ${body.slice(0, 200)}`);
      process.exit(1);
    }

    const me = await resp.json();
    const email = (me.mail || me.userPrincipalName || "").toLowerCase();
    console.log(`  Display name: ${me.displayName}`);
    console.log(`  Email (mail): ${me.mail}`);
    console.log(`  UPN: ${me.userPrincipalName}`);
    console.log(`  ID: ${me.id}`);
    console.log(`  Latency: ${latency3}ms`);

    if (email === EXPECTED_EMAIL.toLowerCase()) {
      console.log(`  Identity match: CONFIRMED (${email})\n`);
    } else {
      console.error(`  Identity MISMATCH: expected ${EXPECTED_EMAIL}, got ${email}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
    process.exit(1);
  }

  // Step 4: Calendar access check
  console.log("--- Step 4: Calendar Access Check ---");
  const start4 = Date.now();
  try {
    const resp = await fetch(`${MS_GRAPH_BASE}/me/calendars?$filter=isDefaultCalendar eq true`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const latency4 = Date.now() - start4;

    if (!resp.ok) {
      const body = await resp.text();
      console.error(`  FAILED: HTTP ${resp.status} - ${body.slice(0, 200)}`);
      process.exit(1);
    }

    const data = await resp.json();
    const defaultCal = data.value?.find((c) => c.isDefaultCalendar);
    if (defaultCal) {
      console.log(`  Default calendar: ${defaultCal.name}`);
      console.log(`  Calendar ID (truncated): ${defaultCal.id.slice(0, 30)}...`);
      console.log(`  Latency: ${latency4}ms`);
      console.log(`  Calendar access: CONFIRMED\n`);
    } else {
      console.error(`  No default calendar found`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
    process.exit(1);
  }

  // Summary
  console.log("=== Bootstrap Verification Summary ===");
  console.log(`Timestamp: ${timestamp}`);
  console.log(`Identity: ${EXPECTED_EMAIL} - CONFIRMED`);
  console.log(`Token exchange: PASS`);
  console.log(`Calendar access: PASS`);
  console.log(`All checks: PASS`);
  console.log(`\nThis account is ready for live test suite usage.`);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
