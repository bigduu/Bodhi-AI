#!/usr/bin/env node

// Prepare the workspace Cargo.toml for a build that resolves bamboo-agent from
// crates.io (every CI job and the release workflow).
//
// Local dev uses [patch.crates-io] to point bamboo-agent at ../bamboo, whose
// source version is the 0.0.0 placeholder. For any crates.io build we must:
//   1. drop the [patch.crates-io] section (its ../bamboo path doesn't exist in
//      a standalone checkout), and
//   2. rewrite the `bamboo-agent = "0.0.0"` placeholder requirement to something
//      resolvable — a pinned version (env BAMBOO_AGENT_VERSION) for a lockstep
//      release, or "*" (latest published) for plain CI.
//
// 0.0.0 is never published, so leaving it would fail resolution — which is the
// whole point of the placeholder: it can't silently ship. Idempotent.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CARGO_TOML = path.join(ROOT, "Cargo.toml");

const requested = (process.env.BAMBOO_AGENT_VERSION || "").trim();
const target = requested || "*";

let content = fs.readFileSync(CARGO_TOML, "utf8");

// 1. Strip [patch.crates-io] (header + everything until the next table header).
if (content.includes("[patch.crates-io]")) {
  const lines = content.split("\n");
  const kept = [];
  let skip = false;
  for (const line of lines) {
    if (line.trim() === "[patch.crates-io]") {
      skip = true;
      continue;
    }
    if (skip && line.startsWith("[")) {
      skip = false;
    }
    if (!skip) {
      kept.push(line);
    }
  }
  content = kept.join("\n");
  console.log("Removed [patch.crates-io] for crates.io build");
} else {
  console.log("No [patch.crates-io] found; already using crates.io");
}

// 2. Rewrite the bamboo-agent placeholder requirement.
const reqPattern = /bamboo-agent\s*=\s*"[^"]*"/;
const match = content.match(reqPattern);
if (match) {
  content = content.replace(reqPattern, `bamboo-agent = "${target}"`);
  console.log(
    `Rewrote ${match[0]} -> bamboo-agent = "${target}" ` +
      (requested ? "(pinned release version)" : "(latest from crates.io)"),
  );
} else {
  console.log("No string-form bamboo-agent requirement found; nothing to rewrite");
}

fs.writeFileSync(CARGO_TOML, content);
