#!/usr/bin/env node
"use strict";

// npm ci uses package-lock.json. Keep the unrelated Yarn lock untouched while
// npm selects its platform-specific optional packages.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

function install(root, target, execute = spawnSync) {
  assert.ok(path.isAbsolute(root));
  const actualRoot = fs.realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim());
  assert.equal(actualRoot, fs.realpathSync(root), "Expected the disposable product checkout");
  assert.equal(execFileSync("git", ["status", "--porcelain", "--", "yarn.lock"], { cwd: root, encoding: "utf8" }).trim(), "");
  const yarn = path.join(root, "yarn.lock"), hidden = path.join(root, ".bodhi-release-yarn-lock");
  const metadata = fs.lstatSync(yarn); assert.ok(metadata.isFile() && !metadata.isSymbolicLink());
  assert.equal(fs.existsSync(hidden), false, "An earlier Yarn lock backup needs inspection");
  const originalYarn = fs.readFileSync(yarn), originalNpm = fs.readFileSync(path.join(root, "package-lock.json"));
  const lock = JSON.parse(originalNpm), expected = lock.packages?.["node_modules/@tauri-apps/cli"]?.version;
  assert.match(expected || "", /^\d+\.\d+\.\d+$/);
  const platform = {
    "aarch64-apple-darwin": ["darwin", "arm64", "cli-darwin-arm64"],
    "x86_64-unknown-linux-gnu": ["linux", "x64", "cli-linux-x64-gnu"],
    "x86_64-pc-windows-msvc": ["win32", "x64", "cli-win32-x64-msvc"],
  }[target];
  assert.ok(platform, "Unsupported native target");
  assert.equal(process.platform, platform[0]); assert.equal(process.arch, platform[1]);
  const optional = lock.packages?.[`node_modules/@tauri-apps/${platform[2]}`]?.version;
  assert.equal(optional, expected, "Platform CLI differs from the committed lock");
  fs.renameSync(yarn, hidden);
  let result;
  try {
    const npmArgs = ["ci", "--prefer-offline", "--no-audit", "--ignore-scripts"];
    result = process.platform === "win32"
      ? execute(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd", ...npmArgs], { cwd: root, stdio: "inherit", env: process.env })
      : execute("npm", npmArgs, { cwd: root, stdio: "inherit", env: process.env });
  } finally {
    // Never overwrite a newly created lock or discard the original on an
    // unexpected npm outcome; leave both files for diagnosis instead.
    if (!fs.existsSync(yarn)) fs.renameSync(hidden, yarn);
  }
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "Locked npm installation failed");
  assert.equal(fs.existsSync(hidden), false, "npm unexpectedly created a Yarn lock; original retained");
  assert.deepEqual(fs.readFileSync(yarn), originalYarn, "Yarn lock changed during npm installation");
  assert.deepEqual(fs.readFileSync(path.join(root, "package-lock.json")), originalNpm, "npm lock changed during installation");
  const installed = JSON.parse(fs.readFileSync(path.join(root, "node_modules/@tauri-apps/cli/package.json"), "utf8"));
  const installedPlatform = JSON.parse(fs.readFileSync(path.join(root, `node_modules/@tauri-apps/${platform[2]}/package.json`), "utf8"));
  assert.equal(installed.version, expected); assert.equal(installedPlatform.version, expected);
  console.log(`Installed locked Tauri CLI ${expected} for ${target}; source locks are unchanged.`);
}

module.exports = { install };
if (require.main === module) {
  try { install(process.env.SOURCE_ROOT, process.env.BAMBOO_SIDECAR_TARGET); }
  catch (error) { console.error(`Release shell dependencies: ${error.message}`); process.exitCode = 1; }
}
