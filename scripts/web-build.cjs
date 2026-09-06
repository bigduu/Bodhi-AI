#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { ROOT, resolveSource, sourceIdentity, localBuildEnvironment, stageDist } = require("./lotus-dist.cjs");

function runNpm(source, args, env) {
  const result = spawnSync("npm", args, { cwd: source.sourceRoot, env, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error || result.status !== 0) throw new Error(`Frontend npm ${args.join(" ")} failed (${result.error?.message || result.status}).`);
}

function buildFrontend(source = resolveSource()) {
  const identity = sourceIdentity(source);
  if (source.mode === "local") {
    runNpm(source, ["run", "build"], localBuildEnvironment(source, process.env, identity));
    // Preserve Lotus Next's package, startup-budget and chunk-ownership gates.
    runNpm(source, ["run", "package:contents"], process.env);
    const after = sourceIdentity(source);
    if (identity.sourceRevision !== after.sourceRevision || identity.sourceDirty !== after.sourceDirty) {
      throw new Error("Lotus Next source revision or dirty status changed during the build. Rebuild from a stable checkout; no new artifact was staged.");
    }
  }
  return stageDist(source, ROOT, identity);
}

module.exports = { buildFrontend };

if (require.main === module) {
  try {
    const command = process.argv[2] || "build";
    const source = resolveSource();
    if (command === "build") buildFrontend(source);
    else if (["dev", "preview"].includes(command)) {
      if (source.mode !== "local") throw new Error(`${command} requires a local Lotus Next checkout; published release packages contain dist only.`);
      if (command === "preview") buildFrontend(source);
      runNpm(source, ["run", command, "--", "--host", "127.0.0.1", "--port", "1420", "--strictPort", ...process.argv.slice(3)], localBuildEnvironment(source));
    } else throw new Error(`Unknown command ${command}; use build, dev or preview.`);
  } catch (error) {
    console.error(`Frontend: ${error.message}`);
    process.exitCode = 1;
  }
}
