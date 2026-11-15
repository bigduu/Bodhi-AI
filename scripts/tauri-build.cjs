"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");

const TARGETS = new Set(["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"]);
const OPTIONS = {
  target: { type: "string", short: "t", multiple: true },
  bundles: { type: "string", short: "b", multiple: true },
  config: { type: "string", short: "c", multiple: true },
  runner: { type: "string", short: "r" },
  debug: { type: "boolean", short: "d" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
  "no-bundle": { type: "boolean" },
};

function appImageTarget(args, env = process.env, platform = process.platform) {
  const target = env.BAMBOO_SIDECAR_TARGET;
  if (platform !== "linux" || env.BAMBOO_SIDECAR_SOURCE !== "release" || !TARGETS.has(target)) return;

  // Clap accepts -t=value and -b=value. Parse these as long forms while
  // forwarding the original process.argv to Tauri.
  const parsedArgs = args.map(arg => arg.replace(/^-t=/, "--target=").replace(/^-b=/, "--bundles="));
  const { values, tokens } = parseArgs({ args: parsedArgs, options: OPTIONS, tokens: true, strict: false, allowPositionals: true });
  if (values.target?.length !== 1 || values.target[0] !== target ||
      values.debug || values["no-bundle"] || values.help || values.version) return;

  let readingBundles = false;
  for (const token of tokens) {
    if (token.kind === "option-terminator") break;
    if (token.kind === "option") readingBundles = token.name === "bundles";
    if (readingBundles && token.value?.split(",").includes("appimage")) return target;
  }
}

module.exports = { appImageTarget };

if (require.main === module) {
  if (appImageTarget(process.argv.slice(3))) {
    const patchelf = path.join(__dirname, "appimage-patchelf.sh");
    fs.accessSync("/usr/bin/patchelf", fs.constants.X_OK);
    fs.accessSync(patchelf, fs.constants.X_OK);
    process.env.NO_STRIP = "1";
    process.env.PATCHELF = patchelf;
  }
  // Use the same locally locked CLI as npm's tauri executable. Loading it in
  // this process preserves its arguments, stdio, signals and exit status.
  require("@tauri-apps/cli/tauri.js");
}
