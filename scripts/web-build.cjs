#!/usr/bin/env node
/**
 * Frontend build entry point for Bodhi.
 *
 * Respects the `LOTUS_SOURCE` environment variable:
 * - `package`  → skip local build, stage dist from the installed npm package
 * - `local`    → build from the local `../lotus` checkout, then stage
 * - `auto`     → build locally if `../lotus` exists, otherwise fall back to package
 */
const { execSync } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = (process.env.LOTUS_SOURCE || "auto").toLowerCase();

function lotusLocalExists() {
  const fs = require("fs");
  const lotusDir = path.resolve(ROOT, process.env.LOTUS_LOCAL_PATH || "../lotus");
  try {
    return fs.statSync(path.join(lotusDir, "package.json")).isFile();
  } catch {
    return false;
  }
}

if (SOURCE !== "package" && lotusLocalExists()) {
  const lotusDir = path.resolve(ROOT, process.env.LOTUS_LOCAL_PATH || "../lotus");
  console.log(`\uD83D\uDD27 Building Lotus from local source at ${lotusDir}...`);
  execSync("npm run build", { cwd: lotusDir, stdio: "inherit" });
} else {
  console.log(`\uD83D\uDCE6 LOTUS_SOURCE=${SOURCE}: skipping local build, staging from package`);
}

// Stage the dist directory (from local or package, as determined by LOTUS_SOURCE).
execSync("node scripts/lotus-dist.cjs stage", { cwd: ROOT, stdio: "inherit" });
