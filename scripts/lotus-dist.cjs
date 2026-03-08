#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIST = path.join(ROOT, ".lotus-dist");
const LEGACY_FRONTEND_MIRROR_PATHS = [
  "index.html",
  "public",
  "src",
  "vite.config.ts",
  "vitest.config.ts",
  "tsconfig.json",
  "tsconfig.node.json",
];
const MIGRATED_FRONTEND_DOC_PATHS = [
  "docs/architecture/FRONTEND_ARCHITECTURE.md",
  "docs/development/README.md",
  "docs/development/STYLING_GUIDELINES.md",
  "docs/development/LIBRARY_INTEGRATION_PLAN.md",
  "docs/development/components/SystemPromptSelector.md",
  "docs/features/MERMAID_ENHANCEMENT_COMPLETE.md",
  "docs/features/command-selector",
  "docs/features/question-dialog",
  "docs/testing/FRONTEND_TESTS_SUMMARY.md",
  "docs/testing/FRONTEND_MERMAID_TESTING.md",
  "docs/tools/MERMAID_EXAMPLES.md",
  "docs/fixes/MERMAID_DYNAMIC_IMPORT_FIX.md",
  "docs/fixes/MERMAID_DYNAMIC_THEME_FIX.md",
  "docs/fixes/MERMAID_THEME_RESPONSIVE_FIX.md",
  "docs/fixes/COPILOT_AUTH_ERROR_HANDLING.md",
  "docs/fixes/MODEL_HARDCODING_FIX_IMPLEMENTATION.md",
  "docs/fixes/MODEL_RACE_CONDITION_FIX.md",
  "docs/fixes/LIMITATIONS_RESOLVED.md",
  "docs/fixes/AGENT_RESUME_FIX_SUMMARY.md",
  "docs/reports/agent-system/AGENT_APPROVAL_FRONTEND_SUMMARY.md",
];

const SOURCE_MODE = (process.env.LOTUS_SOURCE || "auto").toLowerCase();
const LOCAL_PATH = path.resolve(ROOT, process.env.LOTUS_LOCAL_PATH || "../lotus");
const PACKAGE_NAME = process.env.LOTUS_PACKAGE_NAME || "@bigduu/lotus";

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function dirExists(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function localLotusExists() {
  return dirExists(LOCAL_PATH) && fs.existsSync(path.join(LOCAL_PATH, "package.json"));
}

function resolvePackageRoot() {
  try {
    const pkgJsonPath = require.resolve(`${PACKAGE_NAME}/package.json`, {
      paths: [ROOT],
    });
    return path.dirname(pkgJsonPath);
  } catch {
    return null;
  }
}

function runNpmScript(prefix, script) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const npmArgs = ["--prefix", prefix, "run", script];
  let result = spawnSync(npmCmd, npmArgs, {
    stdio: "inherit",
    env: process.env,
  });

  if (typeof result.status === "number") {
    if (result.status !== 0) {
      process.exit(result.status);
    }
    return;
  }

  // Some Windows shells/process environments fail to resolve npm.cmd when
  // spawned directly. Retry once through shell before failing.
  if (process.platform === "win32") {
    const fallbackCommand = `npm --prefix "${prefix}" run ${script}`;
    if (result.error && result.error.message) {
      console.warn(`⚠️ Direct npm launch failed: ${result.error.message}`);
    }
    console.warn(`⚠️ Retrying via shell: ${fallbackCommand}`);
    result = spawnSync(fallbackCommand, {
      stdio: "inherit",
      env: process.env,
      shell: true,
    });

    if (typeof result.status === "number") {
      if (result.status !== 0) {
        process.exit(result.status);
      }
      return;
    }
  }

  fail(`Failed to run npm script "${script}" in ${prefix}`);
}

function hasNpmScript(prefix, script) {
  const packageJsonPath = path.join(prefix, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return Boolean(packageJson && packageJson.scripts && packageJson.scripts[script]);
  } catch {
    return false;
  }
}

function copyDist(sourceDist) {
  if (!dirExists(sourceDist)) {
    fail(`Lotus dist directory not found: ${sourceDist}`);
  }

  fs.rmSync(OUTPUT_DIST, { recursive: true, force: true });
  fs.cpSync(sourceDist, OUTPUT_DIST, { recursive: true });
  console.log(`✅ Synced Lotus dist: ${sourceDist} -> ${OUTPUT_DIST}`);
}

function resolveSource() {
  if (!["auto", "local", "package"].includes(SOURCE_MODE)) {
    fail(`Invalid LOTUS_SOURCE="${SOURCE_MODE}" (expected auto|local|package)`);
  }

  const localAvailable = localLotusExists();
  const packageRoot = resolvePackageRoot();

  if (SOURCE_MODE === "local") {
    if (!localAvailable) {
      fail(
        `LOTUS_SOURCE=local but local Lotus not found at ${LOCAL_PATH}. ` +
          "Set LOTUS_LOCAL_PATH or use LOTUS_SOURCE=package.",
      );
    }
    return { mode: "local", localAvailable, packageRoot };
  }

  if (SOURCE_MODE === "package") {
    if (!packageRoot) {
      fail(
        `LOTUS_SOURCE=package but package "${PACKAGE_NAME}" is not installed. ` +
          "Install it or use LOTUS_SOURCE=local.",
      );
    }
    return { mode: "package", localAvailable, packageRoot };
  }

  if (localAvailable) {
    return { mode: "local", localAvailable, packageRoot };
  }
  if (packageRoot) {
    return { mode: "package", localAvailable, packageRoot };
  }

  fail(
    "No Lotus source found. Expected either:\n" +
      `- local checkout at ${LOCAL_PATH}\n` +
      `- installed package "${PACKAGE_NAME}"`,
  );
}

function stageDist() {
  const resolved = resolveSource();

  if (resolved.mode === "local") {
    console.log(`ℹ️ Using local Lotus at ${LOCAL_PATH}`);
    runNpmScript(LOCAL_PATH, "build");
    copyDist(path.join(LOCAL_PATH, "dist"));
    return;
  }

  const packageRoot = resolved.packageRoot;
  const packageDist = path.join(packageRoot, "dist");
  console.log(`ℹ️ Using packaged Lotus "${PACKAGE_NAME}" at ${packageRoot}`);
  copyDist(packageDist);
}

function runLocalOnly(script) {
  if (!localLotusExists()) {
    fail(
      `Command "${script}" requires local Lotus checkout at ${LOCAL_PATH}. ` +
        "Set LOTUS_LOCAL_PATH or run with a sibling lotus repository.",
    );
  }
  runNpmScript(LOCAL_PATH, script);
}

function runRebrand(script) {
  const resolved = resolveSource();
  if (resolved.mode === "local") {
    if (!hasNpmScript(LOCAL_PATH, script)) {
      console.log(
        `ℹ️ Skipping "${script}" because local Lotus at ${LOCAL_PATH} does not define this script.`,
      );
      return;
    }
    runNpmScript(LOCAL_PATH, script);
    return;
  }

  console.log(
    `ℹ️ Skipping "${script}" because LOTUS_SOURCE resolved to package (${PACKAGE_NAME}).`,
  );
}

function printInfo() {
  const localAvailable = localLotusExists();
  const packageRoot = resolvePackageRoot();

  console.log(`LOTUS_SOURCE=${SOURCE_MODE}`);
  console.log(`LOTUS_LOCAL_PATH=${LOCAL_PATH} (${localAvailable ? "found" : "missing"})`);
  console.log(
    `LOTUS_PACKAGE_NAME=${PACKAGE_NAME} (${packageRoot ? `found at ${packageRoot}` : "missing"})`,
  );

  if (localAvailable) {
    console.log("Selected source (auto): local");
  } else if (packageRoot) {
    console.log("Selected source (auto): package");
  } else {
    console.log("Selected source (auto): unavailable");
  }
}

function verifyMigrationGuard() {
  const existingLegacyPaths = LEGACY_FRONTEND_MIRROR_PATHS.map((relativePath) => ({
    relativePath,
    absolutePath: path.join(ROOT, relativePath),
  })).filter((entry) => fs.existsSync(entry.absolutePath));

  if (existingLegacyPaths.length > 0) {
    console.error("❌ Legacy frontend mirror artifacts detected in bodhi root:");
    for (const entry of existingLegacyPaths) {
      console.error(`   - ${entry.relativePath}`);
    }
    console.error(
      "   Remove these paths. Bodhi must consume Lotus via ../lotus or @bigduu/lotus only.",
    );
    process.exit(1);
  }

  console.log("✅ Migration guard passed: no legacy frontend mirror artifacts found.");
}

function verifyDocsBoundaryGuard() {
  const reintroducedDocs = MIGRATED_FRONTEND_DOC_PATHS.map((relativePath) => ({
    relativePath,
    absolutePath: path.join(ROOT, relativePath),
  })).filter((entry) => fs.existsSync(entry.absolutePath));

  if (reintroducedDocs.length > 0) {
    console.error("❌ Frontend docs migrated to Lotus were reintroduced in bodhi/docs:");
    for (const entry of reintroducedDocs) {
      console.error(`   - ${entry.relativePath}`);
    }
    console.error("   Move frontend docs to ../lotus/docs and keep bodhi/docs shell-focused.");
    process.exit(1);
  }

  console.log("✅ Docs boundary guard passed: no migrated frontend docs found in bodhi/docs.");
}

const command = process.argv[2] || "stage";

if (command === "stage") {
  stageDist();
  process.exit(0);
}

if (command === "info") {
  printInfo();
  process.exit(0);
}

if (command === "dev") {
  runLocalOnly("dev");
  process.exit(0);
}

if (command === "type-check") {
  runLocalOnly("type-check");
  process.exit(0);
}

if (command === "test:run") {
  runLocalOnly("test:run");
  process.exit(0);
}

if (command === "format") {
  runLocalOnly("format");
  process.exit(0);
}

if (command === "format:check") {
  runLocalOnly("format:check");
  process.exit(0);
}

if (command === "rebrand:public") {
  runRebrand("rebrand:public");
  process.exit(0);
}

if (command === "rebrand:internal") {
  runRebrand("rebrand:internal");
  process.exit(0);
}

if (command === "rebrand:check") {
  runRebrand("rebrand:check");
  process.exit(0);
}

if (command === "verify:migration") {
  verifyMigrationGuard();
  process.exit(0);
}

if (command === "verify:docs-boundary") {
  verifyDocsBoundaryGuard();
  process.exit(0);
}

fail(
  `Unknown command "${command}". Use one of: stage, info, dev, type-check, test:run, format, format:check, rebrand:public, rebrand:internal, rebrand:check, verify:migration, verify:docs-boundary.`,
);
