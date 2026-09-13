#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

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
  "docs/reports/agent-system/AGENT_APPROVAL_FRONTEND_SUMMARY.md",
];

function verifyMigrationGuard() {
  const existingLegacyPaths = LEGACY_FRONTEND_MIRROR_PATHS
    .map((relativePath) => ({
      relativePath,
      absolutePath: path.join(ROOT, relativePath),
    }))
    .filter((entry) => fs.existsSync(entry.absolutePath));

  if (existingLegacyPaths.length > 0) {
    console.error("❌ Legacy frontend mirror artifacts detected in bodhi root:");
    for (const entry of existingLegacyPaths) {
      console.error(`   - ${entry.relativePath}`);
    }
    console.error(
      "   Remove these paths. Bodhi must consume Lotus Next via ../lotus-next or the locked @bigduu/lotus-next package.",
    );
    process.exit(1);
  }

  console.log("✅ Migration guard passed: no legacy frontend mirror artifacts found.");
}

function verifyDocsBoundaryGuard() {
  const reintroducedDocs = MIGRATED_FRONTEND_DOC_PATHS
    .map((relativePath) => ({
      relativePath,
      absolutePath: path.join(ROOT, relativePath),
    }))
    .filter((entry) => fs.existsSync(entry.absolutePath));

  if (reintroducedDocs.length > 0) {
    console.error("❌ Frontend docs migrated to Lotus were reintroduced in bodhi/docs:");
    for (const entry of reintroducedDocs) {
      console.error(`   - ${entry.relativePath}`);
    }
    console.error("   Move frontend docs to ../lotus-next/docs and keep bodhi/docs shell-focused.");
    process.exit(1);
  }

  console.log("✅ Docs boundary guard passed: no migrated frontend docs found in bodhi/docs.");
}

const command = process.argv[2];

if (command === "migration") {
  verifyMigrationGuard();
  process.exit(0);
}

if (command === "docs-boundary") {
  verifyDocsBoundaryGuard();
  process.exit(0);
}

if (command === "all") {
  verifyMigrationGuard();
  verifyDocsBoundaryGuard();
  process.exit(0);
}

console.error(`Unknown command "${command}". Use one of: migration, docs-boundary, all.`);
process.exit(1);
