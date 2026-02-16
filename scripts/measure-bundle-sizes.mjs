#!/usr/bin/env node
/**
 * Measure bundle sizes for all Cloudflare Workers.
 *
 * Uses esbuild to bundle each worker entry point (same bundler wrangler uses),
 * then reports raw and gzip-compressed sizes.
 *
 * Usage:
 *   node scripts/measure-bundle-sizes.mjs
 *   node scripts/measure-bundle-sizes.mjs --exclude-pattern "zod"
 */

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { parse } from "smol-toml";

const ROOT = resolve(import.meta.dirname, "..");
const WORKERS_DIR = join(ROOT, "workers");

// Cloudflare Workers external modules (not bundled)
const CF_EXTERNALS = [
  "cloudflare:workers",
  "cloudflare:sockets",
  "node:*",
];

/**
 * Read wrangler.toml to find the entry point for a worker.
 */
function getWorkerEntry(workerDir) {
  const tomlPath = join(workerDir, "wrangler.toml");
  try {
    const content = readFileSync(tomlPath, "utf-8");
    const config = parse(content);
    return config.main || "src/index.ts";
  } catch {
    return "src/index.ts";
  }
}

/**
 * Bundle a worker entry point with esbuild and return the output size info.
 */
async function measureWorker(workerName, options = {}) {
  const workerDir = join(WORKERS_DIR, workerName);
  const entryPoint = join(workerDir, getWorkerEntry(workerDir));

  const external = [...CF_EXTERNALS];
  if (options.excludePattern) {
    external.push(options.excludePattern);
  }

  try {
    const result = await build({
      entryPoints: [entryPoint],
      bundle: true,
      write: false,
      format: "esm",
      target: "es2022",
      platform: "browser", // Workers are browser-like
      minify: true,
      treeShaking: true,
      external,
      // Resolve workspace packages
      conditions: ["import", "module"],
      metafile: true,
    });

    const output = result.outputFiles[0];
    const rawBytes = output.contents.length;
    const gzipBytes = gzipSync(output.contents).length;

    // Parse metafile for module breakdown
    const inputs = result.metafile.inputs;
    let zodBytes = 0;
    for (const [path, info] of Object.entries(inputs)) {
      if (path.includes("zod")) {
        zodBytes += info.bytes;
      }
    }

    return {
      worker: workerName,
      rawBytes,
      gzipBytes,
      rawKB: (rawBytes / 1024).toFixed(1),
      gzipKB: (gzipBytes / 1024).toFixed(1),
      zodInputBytes: zodBytes,
      zodInputKB: (zodBytes / 1024).toFixed(1),
      success: true,
    };
  } catch (err) {
    return {
      worker: workerName,
      error: err.message?.slice(0, 200),
      success: false,
    };
  }
}

// Main
const args = process.argv.slice(2);
const excludeIdx = args.indexOf("--exclude-pattern");
const excludePattern = excludeIdx >= 0 ? args[excludeIdx + 1] : null;

const workerNames = [
  "api",
  "oauth",
  "webhook",
  "sync-consumer",
  "write-consumer",
  "mcp",
  "cron",
  "push",
  "app-gateway",
];

console.log("=== T-Minus Worker Bundle Size Report ===");
console.log(`Mode: ${excludePattern ? `excluding "${excludePattern}"` : "full bundle (with Zod)"}`);
console.log("");

const results = [];
for (const name of workerNames) {
  const result = await measureWorker(name, { excludePattern });
  results.push(result);
}

// Table output
console.log("Worker               | Raw (KB) | Gzip (KB) | Zod Input (KB) | Status");
console.log("---------------------|----------|-----------|-----------------|-------");
for (const r of results) {
  if (r.success) {
    const name = r.worker.padEnd(20);
    const raw = r.rawKB.padStart(8);
    const gzip = r.gzipKB.padStart(9);
    const zod = r.zodInputKB.padStart(15);
    console.log(`${name} | ${raw} | ${gzip} | ${zod} | OK`);
  } else {
    const name = r.worker.padEnd(20);
    console.log(`${name} | FAILED: ${r.error?.slice(0, 60)}`);
  }
}

// Summary
const successful = results.filter((r) => r.success);
if (successful.length > 0) {
  const maxGzip = Math.max(...successful.map((r) => r.gzipBytes));
  const maxWorker = successful.find((r) => r.gzipBytes === maxGzip);
  console.log("");
  console.log(`Largest worker (gzip): ${maxWorker.worker} at ${maxWorker.gzipKB} KB`);
  console.log(`Cloudflare limit: 1,024 KB (1 MB compressed)`);
  console.log(`Headroom: ${(1024 - parseFloat(maxWorker.gzipKB)).toFixed(1)} KB`);
}

// Output JSON for comparison scripts
if (args.includes("--json")) {
  console.log("");
  console.log("--- JSON ---");
  console.log(JSON.stringify(results, null, 2));
}
