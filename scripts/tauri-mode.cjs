#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

function parseArgs(argv) {
  return argv.reduce((acc, arg) => {
    if (!arg.startsWith("--")) return acc;
    const raw = arg.slice(2);
    const eqIndex = raw.indexOf("=");
    if (eqIndex === -1) {
      acc[raw] = true;
      return acc;
    }
    const key = raw.slice(0, eqIndex);
    const value = raw.slice(eqIndex + 1);
    acc[key] = value;
    return acc;
  }, {});
}

const args = parseArgs(process.argv.slice(2));
const mode = args.mode || "public";
const target = args.target || "dev";

if (!["internal", "public"].includes(mode)) {
  console.error(`❌ Unknown mode: ${mode}`);
  process.exit(1);
}

if (!["dev", "build"].includes(target)) {
  console.error(`❌ Unknown target: ${target}`);
  process.exit(1);
}

const env = {
  ...process.env,
  BODHI_INTERNAL_BUILD: mode === "internal" ? "true" : "false",
};

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const npmArgs = ["run", `tauri:${target}`];

const result = spawnSync(npmCmd, npmArgs, {
  stdio: "inherit",
  env,
});

if (typeof result.status === "number") {
  process.exit(result.status);
}

console.error("❌ Failed to launch tauri command");
process.exit(1);
