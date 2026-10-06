#!/usr/bin/env node
const { spawn, execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  assertLoopbackPortAvailable, installInterruptHandlers, runInterruptibleCommand,
  terminateOwnedProcessGroup, throwIfAborted, waitForCondition,
} = require("./managed-restart-contract.cjs");
const { ROOT, resolveSource, sourceIdentity } = require("./lotus-dist.cjs");

function describeListener(port) {
  const read = (args) => {
    try {
      return execFileSync("lsof", args, { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      // lsof can return useful PID/cwd fields with a nonzero status when an
      // unrelated mount is unavailable. This never changes the port verdict.
      if (error.stdout?.length) return String(error.stdout);
      throw error;
    }
  };
  try {
    const fields = read(["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]).trim();
    const pids = [...fields.matchAll(/^p(\d+)$/gm)].map((match) => match[1]);
    return pids.map((pid) => {
      let cwd = "unavailable";
      try {
        cwd = read(["-a", "-p", pid, "-d", "cwd", "-Fn"]).split("\n").find((line) => line.startsWith("n"))?.slice(1) || cwd;
      } catch { /* Port and inspection command remain actionable without lsof. */ }
      const name = fields.split(`p${pid}\n`)[1]?.split("\n").find((line) => line.startsWith("c"))?.slice(1) || "unknown";
      return `PID ${pid} (${name}), checkout/cwd ${cwd}`;
    }).join("; ");
  } catch {
    return `inspect with lsof -nP -iTCP:${port} -sTCP:LISTEN (Windows: Get-NetTCPConnection -LocalPort ${port})`;
  }
}

function startOwnedCommand(spec, env, root) {
  const child = spawn(spec.command, spec.args || [], {
    cwd: spec.cwd || root, env, detached: process.platform !== "win32", stdio: "inherit",
  });
  let error;
  child.once("error", (cause) => { error = cause; });
  const outcome = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal, error })));
  return { child, outcome };
}

function assertSuccess(result, label) {
  if (result.error) throw result.error;
  if (result.code !== 0) throw new Error(`${label} exited with ${result.signal ? `signal ${result.signal}` : `status ${result.code}`}.`);
}

async function runDevLifecycle(options = {}) {
  const root = options.root || ROOT;
  const env = options.env || process.env;
  const args = options.args || [];
  if (args.some((arg) => arg === "--config" || arg.startsWith("-c") || arg.startsWith("--config="))) {
    throw new Error("The owned development entrypoint controls beforeDevCommand and devUrl; --config overrides are unsupported.");
  }
  const port = options.port ?? 1420;
  const signal = options.signal;
  throwIfAborted(signal);
  try {
    await assertLoopbackPortAvailable(port);
  } catch (error) {
    throw new Error(`Bodhi development port ${port} is occupied: ${describeListener(port)}. Requested checkout: ${root}. Stop that run explicitly before retrying; no listener was stopped and no build was started.`, { cause: error });
  }
  const source = options.source || resolveSource(env, root);
  if (source.mode !== "local") throw new Error("tauri:dev requires LOTUS_SOURCE=local and a local Lotus Next checkout.");
  const prepare = options.prepare || { command: process.execPath, args: [path.join(root, "scripts/build-sidecar.cjs"), "--debug"] };
  await runInterruptibleCommand(prepare.command, prepare.args, { cwd: prepare.cwd || root, env, signal, visible: true });
  throwIfAborted(signal);
  const expected = { sourceRoot: fs.realpathSync(source.sourceRoot), sourceRevision: sourceIdentity(source).sourceRevision };
  const runId = randomUUID();
  const runEnv = { ...env, BODHI_DEV_RUN_ID: runId, BODHI_DEV_PORT: String(port) };
  const frontend = startOwnedCommand(options.frontend || { command: process.execPath, args: [path.join(root, "scripts/web-dev.cjs")] }, runEnv, root);
  let native;
  let interrupted;
  const interruption = new Promise((resolve) => { interrupted = resolve; });
  const onAbort = () => interrupted({ error: signal.reason || new Error("Bodhi development interrupted.") });
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const frontendExit = frontend.outcome.then((result) => ({ error: result.error || new Error(`Owned frontend exited before the native app (${result.signal || result.code}).`) }));
  const readiness = new AbortController();
  const readinessSignal = signal ? AbortSignal.any([signal, readiness.signal]) : readiness.signal;
  let failure;
  try {
    const ready = waitForCondition(async () => {
        const requestSignal = AbortSignal.any([readinessSignal, AbortSignal.timeout(1_000)]);
        const response = await fetch(`http://127.0.0.1:${port}/__bodhi_dev_identity?run=${runId}`, { signal: requestSignal, redirect: "error" });
        if (!response.ok) throw new Error(`Frontend identity HTTP ${response.status}.`);
        const identity = await response.json();
        if (identity.runId !== runId || identity.pid !== frontend.child.pid || identity.sourceRoot !== expected.sourceRoot || identity.sourceRevision !== expected.sourceRevision) {
          throw new Error("Frontend identity does not match this run's child and checkout.");
        }
        const index = await fetch(`http://127.0.0.1:${port}/`, { signal: requestSignal, redirect: "error" });
        if (!index.ok) throw new Error(`Frontend index HTTP ${index.status}.`);
        await index.text();
        return identity;
      }, { signal: readinessSignal, timeoutMs: options.readinessTimeoutMs || 30_000, label: "This run's frontend readiness" });
    const first = await Promise.race([ready.then((identity) => ({ identity })), frontendExit, interruption]);
    if (first.error) throw first.error;
    throwIfAborted(signal);
    const config = { build: { beforeDevCommand: null, devUrl: `http://127.0.0.1:${port}/__bodhi_startup?run=${runId}` } };
    // Keep our CLI config before `--` cargo/app arguments. It must never be
    // forwarded to the application as if it were an application argument.
    const command = options.native || { command: process.execPath, args: [path.join(root, "node_modules/@tauri-apps/cli/tauri.js"), "dev", "--config", JSON.stringify(config), ...args] };
    console.log(`Starting native Bodhi against owned frontend pid=${frontend.child.pid}, checkout=${expected.sourceRoot}.`);
    native = startOwnedCommand(command, runEnv, root);
    const result = await Promise.race([native.outcome.then((value) => ({ native: value })), frontendExit, interruption]);
    if (result.error) throw result.error;
    assertSuccess(result.native, "Tauri development");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    readiness.abort(new Error("Bodhi frontend readiness stopped."));
    signal?.removeEventListener("abort", onAbort);
    // Native owns Bamboo's existing death-link. Finish that tree before Vite.
    const failures = [];
    for (const owned of [native, frontend]) {
      if (!owned || !owned.child.pid) continue;
      try { await terminateOwnedProcessGroup(owned.child, { detached: process.platform !== "win32" }); }
      catch (error) { failures.push(error.message); }
    }
    if (failures.length) throw new Error(`${failure ? `${failure.message} ` : ""}Bodhi development cleanup failed: ${failures.join("; ")}`, { cause: failure });
  }
}

module.exports = { runDevLifecycle, describeListener };
if (require.main === module) {
  const interrupts = installInterruptHandlers(process, "Bodhi development");
  runDevLifecycle({ args: process.argv.slice(2), signal: interrupts.signal }).catch((error) => {
    console.error(`Bodhi development failed: ${error.message}`);
    process.exitCode = error.signal === "SIGINT" ? 130 : error.signal === "SIGTERM" ? 143 : 1;
  }).finally(() => interrupts.dispose());
}
