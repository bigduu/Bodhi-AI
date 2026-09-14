#!/usr/bin/env node

const { execFileSync, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const {
  allocateLoopbackPort,
  assertEvidenceRedacted,
  assertFullRevision,
  assertIdentityMatches,
  assertLoopbackPortAvailable,
  assertOwnedAbsolutePath,
  assertScreenshotEvidenceUnchanged,
  distinctLaunchScreenshots,
  installInterruptHandlers,
  isolatedChildEnvironment,
  managedSidecarTeardownComplete,
  observeChildProcessErrors,
  pngEvidenceMetadata,
  redactText,
  runInterruptibleCommand,
  terminateOwnedChild,
  terminateVerifiedProcess,
  validateBrowserReceipt,
  waitForInteractiveConfirmation,
  waitForCondition,
} = require("./managed-restart-contract.cjs");
const { NEXT_PACKAGE, resolveSource, sourceIdentity, verifyStaged } = require("./lotus-dist.cjs");
const { verifySidecar } = require("./verify-assembly.cjs");

const ROOT = path.resolve(__dirname, "..");
const PROVIDER_SCRIPT = path.join(__dirname, "managed-restart-provider.py");
const ARTIFACT_LOCK_PATH = path.join(__dirname, "frontend-package-lock.json");
const MODEL = "gpt-4o-mini";
const PROVIDER = "bodhi-restart-acceptance";
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const READY_TIMEOUT_MS = 90_000;
const SESSION_TIMEOUT_MS = 60_000;

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Required environment variable ${name} is missing.`);
  return value.trim();
}

function commandText(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function repositoryIdentity(directory, expected, label, signal) {
  const top = fs.realpathSync(
    (
      await runInterruptibleCommand("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
        signal,
      })
    ).stdout.trim(),
  );
  if (top !== fs.realpathSync(directory)) {
    throw new Error(`${label} source must be the Git checkout root.`);
  }
  const head = (
    await runInterruptibleCommand("git", ["-C", directory, "rev-parse", "HEAD^{commit}"], {
      signal,
    })
  ).stdout.trim();
  assertIdentityMatches(head, expected, label);
  const status = (
    await runInterruptibleCommand(
      "git",
      ["-C", directory, "status", "--porcelain=v1", "--untracked-files=all"],
      { signal },
    )
  ).stdout.trim();
  if (status) {
    throw new Error(`${label} source must be clean; Git reported ${status.split(/\r?\n/u).length} changed path(s).`);
  }
  return { directory: top, revision: head, clean: true };
}

function readArtifactLock() {
  const lock = JSON.parse(fs.readFileSync(ARTIFACT_LOCK_PATH, "utf8"));
  if (
    lock.schemaVersion !== 1 ||
    lock.packageName !== NEXT_PACKAGE ||
    typeof lock.packageVersion !== "string" ||
    !lock.packageVersion ||
    !/^[0-9a-f]{40}$/u.test(lock.sourceRevision) ||
    lock.sourceDirty !== false ||
    !/^[0-9a-f]{64}$/u.test(lock.resourcesSha256) ||
    !/^[0-9a-f]{64}$/u.test(lock.manifestSha256)
  ) {
    throw new Error("The committed Lotus Next artifact lock is incomplete or invalid.");
  }
  return lock;
}

async function hostTriple(signal) {
  const { stdout } = await runInterruptibleCommand("rustc", ["-vV"], { signal });
  const output = stdout.trim();
  const match = output.match(/^host:\s*(\S+)$/mu);
  if (!match) throw new Error("rustc did not report a host target triple.");
  return match[1];
}

function normalizeMachOLinkeditVirtualSize(bytes, label) {
  if (bytes.length < 32 || bytes.subarray(0, 4).toString("hex") !== "cffaedfe") {
    throw new Error(`${label} is not a thin little-endian 64-bit Mach-O executable.`);
  }
  const commandCount = bytes.readUInt32LE(16);
  const commandsSize = bytes.readUInt32LE(20);
  const commandsEnd = 32 + commandsSize;
  if (commandCount === 0 || commandCount > 256 || commandsEnd > bytes.length) {
    throw new Error(`${label} has an invalid Mach-O load-command table.`);
  }
  let offset = 32;
  let linkeditCount = 0;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > commandsEnd) throw new Error(`${label} has a truncated Mach-O load command.`);
    const command = bytes.readUInt32LE(offset);
    const commandSize = bytes.readUInt32LE(offset + 4);
    if (commandSize < 8 || offset + commandSize > commandsEnd) {
      throw new Error(`${label} has an invalid Mach-O load-command size.`);
    }
    if (command === 0x19 && commandSize >= 72) {
      const segmentName = bytes.subarray(offset + 8, offset + 24).toString("utf8").replace(/\0+$/u, "");
      if (segmentName === "__LINKEDIT") {
        // codesign may adjust only this virtual-size field while replacing the
        // reserved signature. The signed bytes themselves are removed on a copy.
        bytes.fill(0, offset + 32, offset + 40);
        linkeditCount += 1;
      }
    }
    offset += commandSize;
  }
  if (offset !== commandsEnd || linkeditCount !== 1) {
    throw new Error(`${label} did not contain one canonical __LINKEDIT segment.`);
  }
}

async function unsignedMachOHash(binary, scratchDirectory, label, signal) {
  const copy = assertOwnedAbsolutePath(
    scratchDirectory,
    path.join(scratchDirectory, `${label}.unsigned`),
    `${label} signature copy`,
  );
  fs.copyFileSync(binary, copy, fs.constants.COPYFILE_EXCL);
  try {
    await runInterruptibleCommand("codesign", ["--remove-signature", copy], { signal });
    const bytes = fs.readFileSync(copy);
    normalizeMachOLinkeditVirtualSize(bytes, label);
    return sha256(bytes);
  } finally {
    fs.rmSync(copy, { force: true });
  }
}

async function verifyBundledSidecarIdentity(
  sourceBinary,
  bundledBinary,
  bundleRoot,
  scratchDirectory,
  signal,
) {
  await runInterruptibleCommand("codesign", ["--verify", "--strict", bundledBinary], { signal });
  await runInterruptibleCommand("codesign", ["--verify", "--deep", "--strict", bundleRoot], { signal });
  const sourceUnsignedSha256 = await unsignedMachOHash(
    sourceBinary,
    scratchDirectory,
    "source-sidecar",
    signal,
  );
  const bundledUnsignedSha256 = await unsignedMachOHash(
    bundledBinary,
    scratchDirectory,
    "bundled-sidecar",
    signal,
  );
  if (sourceUnsignedSha256 !== bundledUnsignedSha256) {
    throw new Error("The signed app bundle changed the Bamboo sidecar executable content.");
  }
  return {
    bundledSignedSha256: sha256(fs.readFileSync(bundledBinary)),
    signatureValid: true,
    unsignedContentSha256: sourceUnsignedSha256,
  };
}

async function prepareApplication(bambooDirectory, artifactLock, scratchDirectory, signal) {
  console.log("Preparing the exact locked Lotus Next package and compiled Bodhi application…");
  await runInterruptibleCommand("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: ROOT,
    signal,
    visible: true,
  });
  await runInterruptibleCommand(
    "npm",
    [
      "install",
      "--no-save",
      "--ignore-scripts",
      "--package-lock=false",
      `${artifactLock.packageName}@${artifactLock.packageVersion}`,
    ],
    { cwd: ROOT, signal, visible: true },
  );
  const buildEnvironment = {
    ...process.env,
    BAMBOO_LOCAL_PATH: bambooDirectory,
    BAMBOO_SIDECAR_SOURCE: "local",
    CARGO_TARGET_DIR: path.join(ROOT, "target"),
    LOTUS_PACKAGE_NAME: NEXT_PACKAGE,
    LOTUS_SOURCE: "package",
    VITE_BACKEND_BASE_URL: "",
  };
  await runInterruptibleCommand("node", ["scripts/build-sidecar.cjs", "--debug"], {
    cwd: ROOT,
    env: buildEnvironment,
    signal,
    visible: true,
  });
  const source = resolveSource(buildEnvironment, ROOT);
  const identity = sourceIdentity(source);
  const receipt = verifyStaged(source, ROOT);
  const triple = await hostTriple(signal);
  const sidecar = verifySidecar(ROOT, triple);

  // The packaged frontend carries newer Tauri JavaScript APIs for its own
  // browser bundle. Remove those transient dependencies before invoking the
  // shell CLI so its normal JS/Rust version compatibility gate remains active.
  await runInterruptibleCommand("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: ROOT,
    signal,
    visible: true,
  });
  await runInterruptibleCommand(
    "npm",
    [
      "run",
      "tauri",
      "--",
      "build",
      "--debug",
      "--bundles",
      "app",
      "--config",
      JSON.stringify({ build: { beforeBuildCommand: "" } }),
    ],
    { cwd: ROOT, env: buildEnvironment, signal, visible: true },
  );

  const builtBundleRoot = path.join(ROOT, "target", "debug", "bundle", "macos", "Bodhi AI.app");
  const bundleRoot = assertOwnedAbsolutePath(
    scratchDirectory,
    path.join(scratchDirectory, "Bodhi AI acceptance.app"),
    "run-owned application bundle",
  );
  if (fs.existsSync(bundleRoot)) throw new Error("The run-owned application bundle path already exists.");
  await runInterruptibleCommand("ditto", [builtBundleRoot, bundleRoot], { signal });
  const executable = fs.realpathSync(path.join(bundleRoot, "Contents", "MacOS", "bodhi"));
  const bundledSidecar = fs.realpathSync(path.join(bundleRoot, "Contents", "MacOS", "bamboo"));
  const metadata = fs.lstatSync(executable);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size < 65_536) {
    throw new Error(`Compiled Bodhi executable is missing or invalid at ${executable}.`);
  }
  const bundledSidecarMetadata = fs.lstatSync(bundledSidecar);
  if (bundledSidecarMetadata.isSymbolicLink() || !bundledSidecarMetadata.isFile()) {
    throw new Error("The app bundle does not contain a regular Bamboo sidecar executable.");
  }
  const bundledSidecarIdentity = await verifyBundledSidecarIdentity(
    sidecar.binary,
    bundledSidecar,
    bundleRoot,
    scratchDirectory,
    signal,
  );
  return { bundledSidecar, bundledSidecarIdentity, executable, identity, receipt, sidecar, triple };
}

function mkdirPrivate(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writePrivateJson(file, value, secrets = []) {
  assertEvidenceRedacted(value, secrets);
  mkdirPrivate(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function writePrivateText(file, value, secrets = []) {
  const redacted = redactText(value, secrets);
  assertEvidenceRedacted(redacted, secrets);
  mkdirPrivate(path.dirname(file));
  fs.writeFileSync(file, redacted.endsWith("\n") ? redacted : `${redacted}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(file, 0o600);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sentinelSnapshot(paths) {
  return Object.fromEntries(paths.map((file) => [path.basename(path.dirname(file)), sha256(fs.readFileSync(file))]));
}

function createRuntime(expectedBodhi, expectedBamboo) {
  const createdRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-managed-restart-"));
  fs.chmodSync(createdRoot, 0o700);
  const runRoot = fs.realpathSync(createdRoot);
  const directories = Object.fromEntries(
    [
      "bambooData",
      "bambooWorkspaces",
      "cache",
      "config",
      "data",
      "evidence",
      "jianduData",
      "logs",
      "provider",
      "screenshots",
      "syntheticHome",
      "tmp",
    ].map(
      (name) => [name, assertOwnedAbsolutePath(runRoot, path.join(runRoot, name), name)],
    ),
  );
  directories.project = assertOwnedAbsolutePath(
    runRoot,
    path.join(directories.bambooWorkspaces, "project"),
    "Project workspace",
  );
  for (const directory of Object.values(directories)) mkdirPrivate(directory);
  const defaultBamboo = path.join(directories.syntheticHome, ".bamboo");
  const defaultJiandu = path.join(directories.syntheticHome, ".jiandu");
  mkdirPrivate(defaultBamboo);
  mkdirPrivate(defaultJiandu);
  const sentinelFiles = [path.join(defaultBamboo, "sentinel"), path.join(defaultJiandu, "sentinel")];
  for (const file of sentinelFiles) fs.writeFileSync(file, "must-remain-unchanged\n", { mode: 0o600 });

  const providerScript = path.join(directories.provider, "managed-restart-provider.py");
  fs.copyFileSync(PROVIDER_SCRIPT, providerScript);
  fs.chmodSync(providerScript, 0o500);
  const runId = crypto.randomUUID();
  const memoryTail = `project-memory-tail-${runId}`;
  return {
    app: null,
    browserExpectations: {},
    expectedBamboo,
    expectedBodhi,
    runId,
    runRoot,
    directories,
    provider: null,
    providerScript,
    providerKey: `synthetic-${crypto.randomUUID()}`,
    providerObservations: path.join(directories.evidence, "provider-observations.json"),
    markers: {
      assistant: `assistant-${runId}`,
      child: `child-${runId}`,
      memoryBody: [
        `confirmed project memory body ${runId}`,
        "This synthetic persistence payload is deliberately longer than the compact query projection. ".repeat(18),
        memoryTail,
      ].join("\n"),
      memoryKeyword: `restart-memory-${runId}`,
      memoryTail,
      restart: `restart-${runId}`,
      root: `root-${runId}`,
      sessionNote: `session-note-${runId}`,
    },
    sentinelBefore: sentinelSnapshot(sentinelFiles),
    sentinelFiles,
  };
}

function bambooConfig(providerPort, providerKey) {
  return {
    setup: { completed: true, completed_at: "1970-01-01T00:00:00Z", version: 1 },
    features: { provider_model_ref: true },
    provider_instances: {
      [PROVIDER]: {
        provider_type: "openai",
        label: "Bodhi restart acceptance",
        api_key: providerKey,
        base_url: `http://127.0.0.1:${providerPort}/v1`,
        model: MODEL,
        fast_model: MODEL,
        enabled: true,
      },
    },
    default_provider_instance: PROVIDER,
    defaults: {
      chat: { provider: PROVIDER, model: MODEL },
      fast: { provider: PROVIDER, model: MODEL },
    },
    memory: {
      background_model: null,
      auto_dream_enabled: false,
      project_prompt_injection: false,
      relevant_recall: false,
      relevant_recall_rerank: false,
      project_first_dream: false,
      ledger_agenda_injection: false,
      ledger_gardener_enabled: false,
      ledger_distillation_enabled: false,
      gardener_enabled: false,
      dedup_gardener_enabled: false,
      memory_active_capacity: 0,
      granularity_freshness_gardener_enabled: false,
    },
  };
}

function writeRuntimeConfig(state, providerPort) {
  writePrivateJson(path.join(state.directories.bambooData, "config.json"), bambooConfig(providerPort, state.providerKey));
  writePrivateJson(path.join(state.directories.bambooData, "bodhi_cli_install_offer.json"), {
    offered_at: "1970-01-01T00:00:00Z",
    answer: "acceptance-isolated",
  });
  writePrivateJson(path.join(state.directories.bambooData, "permissions.json"), {
    schema_version: 1,
    revision: 1,
    data: {
      whitelist: [],
      enabled: true,
      session_grant_duration_secs: 1800,
      mode: "auto",
      ask_rules: [],
      durable_rules: [],
    },
  });
}

function boundedLogCollector() {
  let value = "";
  return {
    append(chunk) {
      value += chunk.toString("utf8");
      if (Buffer.byteLength(value) > MAX_LOG_BYTES) {
        value = `[earlier output truncated]\n${value.slice(-Math.floor(MAX_LOG_BYTES / 2))}`;
      }
    },
    value() {
      return value;
    },
  };
}

async function startProvider(state, port, signal) {
  await assertLoopbackPortAvailable(port, { signal });
  const stdout = boundedLogCollector();
  const stderr = boundedLogCollector();
  const child = spawn("python3", [state.providerScript], {
    cwd: ROOT,
    env: isolatedChildEnvironment(process.env, {
      BODHI_ACCEPTANCE_ASSISTANT_MARKER: state.markers.assistant,
      BODHI_ACCEPTANCE_CHILD_MARKER: state.markers.child,
      BODHI_ACCEPTANCE_JIANDU_DATA_DIR: state.directories.jianduData,
      BODHI_ACCEPTANCE_PROVIDER_KEY: state.providerKey,
      BODHI_ACCEPTANCE_PROVIDER_OBSERVATIONS: state.providerObservations,
      BODHI_ACCEPTANCE_PROVIDER_PORT: String(port),
      BODHI_ACCEPTANCE_RESTART_MARKER: state.markers.restart,
      BODHI_ACCEPTANCE_ROOT_MARKER: state.markers.root,
      BODHI_ACCEPTANCE_SESSION_NOTE_MARKER: state.markers.sessionNote,
      HOME: state.directories.syntheticHome,
      TMPDIR: state.directories.tmp,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => stdout.append(chunk));
  child.stderr?.on("data", (chunk) => stderr.append(chunk));
  const processErrors = observeChildProcessErrors(child, "deterministic provider", signal, (error) => {
    stderr.append(`${error.message}\n`);
  });
  state.provider = { child, port, processErrors, stdout, stderr };
  await waitForCondition(
    async () => {
      if (processErrors.failure) throw processErrors.failure;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`provider exited early: ${stderr.value()}`);
      }
      const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Authorization: `Bearer ${state.providerKey}` },
        signal: AbortSignal.any([processErrors.signal, AbortSignal.timeout(1_000)]),
      });
      return response.status === 200 && fs.existsSync(state.providerObservations);
    },
    {
      timeoutMs: 15_000,
      intervalMs: 100,
      label: "deterministic provider readiness",
      signal: processErrors.signal,
    },
  );
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function processParent(pid) {
  const value = commandText("ps", ["-o", "ppid=", "-p", String(pid)]);
  const parent = Number(value);
  if (!Number.isInteger(parent) || parent < 1) throw new Error(`Cannot resolve parent for process ${pid}.`);
  return parent;
}

function processCommandName(pid) {
  const value = commandText("ps", ["-o", "comm=", "-p", String(pid)]);
  return path.basename(value);
}

function processIdentity(pid) {
  if (!processExists(pid)) return null;
  try {
    const startedAt = commandText("ps", ["-o", "lstart=", "-p", String(pid)]);
    const command = commandText("ps", ["-ww", "-o", "comm=", "-p", String(pid)]);
    if (!startedAt || !command || !processExists(pid)) return null;
    return { pid, startedAt, command };
  } catch (error) {
    if (!processExists(pid)) return null;
    throw error;
  }
}

function exactCommandProcessIdentities(expectedCommand, excluded = new Set()) {
  const expected = fs.realpathSync(expectedCommand);
  const output = commandText("ps", ["-ww", "-axo", "pid=,lstart=,comm="]);
  const identities = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/u);
    if (!match) continue;
    const pid = Number(match[1]);
    if (excluded.has(pid) || match[3].trim() !== expected) continue;
    identities.push({ pid, startedAt: match[2], command: match[3].trim() });
  }
  return identities.sort((left, right) => left.pid - right.pid);
}

function directChildren(pid) {
  try {
    return commandText("pgrep", ["-P", String(pid)])
      .split(/\s+/u)
      .filter(Boolean)
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

function listenerOwners(port) {
  try {
    const output = commandText("lsof", [
      "-nP",
      "-a",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-Fp",
    ]);
    return [...new Set(output.split(/\r?\n/u).filter((line) => /^p\d+$/u.test(line)).map((line) => Number(line.slice(1))))];
  } catch {
    return [];
  }
}

function retainManagedSidecarIdentity(app, expectedPid = null) {
  if (app.sidecarIdentity) {
    if (expectedPid !== null && app.sidecarIdentity.pid !== expectedPid) {
      throw new Error(`Managed Bamboo identity changed from ${app.sidecarIdentity.pid} to ${expectedPid}.`);
    }
    return app.sidecarIdentity;
  }

  const log = stripAnsi(`${app.stdout.value()}\n${app.stderr.value()}`);
  const matches = [...log.matchAll(/Managed bamboo pid=(\d+) port=(\d+)/gu)];
  if (matches.length > 1) throw new Error(`Expected at most one managed Bamboo spawn log, found ${matches.length}.`);
  const loggedPid = matches.length === 1 ? managedSidecarFromLog(log, app.port).pid : null;
  const children = processExists(app.child.pid)
    ? directChildren(app.child.pid).filter((pid) => {
        try {
          return processCommandName(pid).toLowerCase().includes("bamboo");
        } catch {
          return false;
        }
      })
    : [];
  if (children.length > 1) throw new Error(`Bodhi owns ambiguous Bamboo children: ${JSON.stringify(children)}.`);
  const exactCandidates = exactCommandProcessIdentities(app.sidecarExecutable, new Set([app.child.pid]));
  if (exactCandidates.length > 1) {
    throw new Error(`The run-owned bundle has ambiguous Bamboo processes: ${JSON.stringify(exactCandidates.map(({ pid }) => pid))}.`);
  }
  const exactPid = exactCandidates[0]?.pid ?? null;
  const observedPids = [...new Set([expectedPid, loggedPid, children[0], exactPid].filter((pid) => pid !== null && pid !== undefined))];
  if (observedPids.length > 1) {
    throw new Error(`Managed Bamboo identity evidence disagrees: ${JSON.stringify(observedPids)}.`);
  }
  const pid = observedPids[0] ?? null;
  if (pid === null) return null;
  app.sidecarPid = pid;
  const identity = processIdentity(pid);
  if (!identity) return null;
  const commandMatches = identity.command === app.sidecarExecutable;
  const direct = processExists(app.child.pid) && processParent(pid) === app.child.pid;
  const owners = listenerOwners(app.port);
  const exclusiveListener = owners.length === 1 && owners[0] === pid;
  const runOwnedExecutable = exactPid === pid;
  if (!commandMatches || (!direct && !exclusiveListener && !runOwnedExecutable) || (owners.length > 0 && !exclusiveListener)) {
    throw new Error(`Cannot prove process ${pid} is the managed Bamboo child for port ${app.port}.`);
  }
  app.sidecarIdentity = identity;
  return identity;
}

function processListeners(pid) {
  try {
    const output = commandText("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"]);
    return output
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("n"))
      .map((line) => line.slice(1))
      .sort();
  } catch {
    return [];
  }
}

function snapshotRelevantProcesses(excluded = new Set()) {
  const output = commandText("ps", ["-ww", "-axo", "pid=,ppid=,lstart=,comm="]);
  const entries = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/u);
    if (!match) continue;
    const pid = Number(match[1]);
    if (excluded.has(pid)) continue;
    const command = path.basename(match[4]).toLowerCase();
    if (!command.includes("bamboo") && !command.includes("bodhi") && !command.includes("nova")) continue;
    entries.push({
      pid,
      ppid: Number(match[2]),
      startedAt: match[3],
      command,
      listeners: command.includes("bamboo") ? processListeners(pid) : [],
    });
  }
  return entries.sort((left, right) => left.pid - right.pid);
}

function snapshotJianduProcesses(excluded = new Set()) {
  const output = commandText("ps", ["-ww", "-axo", "pid=,comm="]);
  return output
    .split(/\r?\n/u)
    .map((line) => line.match(/^\s*(\d+)\s+(.+)$/u))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), command: path.basename(match[2]).toLowerCase() }))
    .filter((entry) => !excluded.has(entry.pid) && entry.command.includes("jiandu"))
    .sort((left, right) => left.pid - right.pid);
}

async function fetchPayload(url, options = {}, expectedStatuses = [200]) {
  const { signal, timeoutMs = 5_000, ...requestOptions } = options;
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { ...requestOptions, signal: requestSignal });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!expectedStatuses.includes(response.status)) {
    const summary = typeof body === "string" ? body.slice(0, 1_000) : JSON.stringify(body).slice(0, 1_000);
    throw new Error(`${options.method ?? "GET"} ${new URL(url).pathname} returned ${response.status}: ${summary}`);
  }
  return { body, headers: response.headers, status: response.status, text };
}

function jsonRequest(method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function parseToolResponse(body, expectedTool) {
  if (!body || typeof body !== "object" || typeof body.result !== "string") {
    throw new Error(`${expectedTool} returned an invalid tool envelope.`);
  }
  const envelope = JSON.parse(body.result);
  if (envelope.tool_name !== expectedTool || envelope.success !== true || typeof envelope.result !== "string") {
    throw new Error(`${expectedTool} reported failure: ${JSON.stringify(envelope).slice(0, 2_000)}`);
  }
  try {
    return JSON.parse(envelope.result);
  } catch {
    return envelope.result;
  }
}

async function executeTool(baseUrl, sessionId, toolName, args, signal) {
  const parameters = Object.entries(args).map(([name, value]) => ({
    name,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
  const response = await fetchPayload(
    `${baseUrl}/api/v1/tools/execute`,
    { ...jsonRequest("POST", { tool_name: toolName, parameters, session_id: sessionId }), signal },
  );
  return parseToolResponse(response.body, toolName);
}

async function waitForHistoryMarker(baseUrl, sessionId, marker, signal) {
  return await waitForCondition(
    async () => {
      const response = await fetchPayload(
        `${baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/history`,
        { signal },
      );
      return JSON.stringify(response.body).includes(marker) ? response.body : false;
    },
    {
      timeoutMs: SESSION_TIMEOUT_MS,
      intervalMs: 200,
      label: `session ${sessionId} provider completion`,
      signal,
    },
  );
}

function managedSidecarFromLog(log, expectedPort) {
  const normalized = stripAnsi(log);
  const matches = [...normalized.matchAll(/Managed bamboo pid=(\d+) port=(\d+)/gu)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one managed Bamboo spawn log, found ${matches.length}.`);
  }
  const pid = Number(matches[0][1]);
  const port = Number(matches[0][2]);
  if (port !== expectedPort) throw new Error(`Managed Bamboo bound unexpected port ${port}.`);
  return { pid, port, normalizedLog: normalized };
}

async function startBodhi(state, build, port, launchNumber, signal) {
  await assertLoopbackPortAvailable(port, { signal });
  const sidecarExecutable = fs.realpathSync(build.bundledSidecar);
  const preExistingSidecars = exactCommandProcessIdentities(sidecarExecutable);
  if (preExistingSidecars.length !== 0) {
    throw new Error(`The run-owned Bamboo executable is already active: ${JSON.stringify(preExistingSidecars.map(({ pid }) => pid))}.`);
  }
  const stdout = boundedLogCollector();
  const stderr = boundedLogCollector();
  const launchedAtMs = Date.now();
  const child = spawn(build.executable, [], {
    cwd: ROOT,
    env: isolatedChildEnvironment(process.env, {
      BAMBOO_DATA_DIR: state.directories.bambooData,
      BAMBOO_JIANDU_DATA_DIR: state.directories.jianduData,
      BAMBOO_RATE_LIMIT_BURST: "1000",
      BAMBOO_RATE_LIMIT_PER_SECOND: "1000",
      BAMBOO_WORKSPACE_ROOT: state.directories.bambooWorkspaces,
      BODHI_BACKEND_PORT: String(port),
      BODHI_SIDECAR_FRONTEND: "1",
      BODHI_WEBVIEW_DIAG: "1",
      CFFIXED_USER_HOME: state.directories.syntheticHome,
      HOME: state.directories.syntheticHome,
      RUST_LOG: "info,bamboo.memory=info",
      TMPDIR: state.directories.tmp,
      XDG_CACHE_HOME: state.directories.cache,
      XDG_CONFIG_HOME: state.directories.config,
      XDG_DATA_HOME: state.directories.data,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => stdout.append(chunk));
  child.stderr?.on("data", (chunk) => stderr.append(chunk));
  const app = {
    child,
    launchedAtMs,
    launchNumber,
    port,
    stdout,
    stderr,
    sidecarExecutable,
    sidecarIdentity: null,
    sidecarPid: null,
  };
  const processErrors = observeChildProcessErrors(child, `Bodhi launch ${launchNumber}`, signal, (error) => {
    stderr.append(`${error.message}\n`);
  });
  app.processErrors = processErrors;
  state.app = app;

  await waitForCondition(
    () => {
      if (processErrors.failure) throw processErrors.failure;
      retainManagedSidecarIdentity(app);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Bodhi exited before spawning Bamboo: ${stderr.value()}\n${stdout.value()}`);
      }
      return /Managed bamboo pid=\d+ port=\d+/u.test(stripAnsi(`${stdout.value()}\n${stderr.value()}`));
    },
    {
      timeoutMs: READY_TIMEOUT_MS,
      intervalMs: 100,
      label: "managed sidecar identity log",
      signal: processErrors.signal,
    },
  );
  const sidecar = managedSidecarFromLog(`${stdout.value()}\n${stderr.value()}`, port);
  if (!retainManagedSidecarIdentity(app, sidecar.pid)) {
    throw new Error(`Managed Bamboo ${sidecar.pid} exited before its identity could be retained.`);
  }

  await waitForCondition(
    async () => {
      if (processErrors.failure) throw processErrors.failure;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Bodhi exited before readiness: ${stderr.value()}\n${stdout.value()}`);
      }
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        signal: AbortSignal.any([processErrors.signal, AbortSignal.timeout(1_000)]),
      });
      return response.status === 200;
    },
    {
      timeoutMs: READY_TIMEOUT_MS,
      intervalMs: 150,
      label: `Bodhi launch ${launchNumber}`,
      signal: processErrors.signal,
    },
  );
  const bambooChildren = directChildren(child.pid).filter((pid) => processCommandName(pid).toLowerCase().includes("bamboo"));
  if (bambooChildren.length !== 1 || bambooChildren[0] !== sidecar.pid) {
    throw new Error(`Bodhi must own exactly one Bamboo child; observed ${JSON.stringify(bambooChildren)}.`);
  }
  const owners = listenerOwners(port);
  if (owners.length !== 1 || owners[0] !== sidecar.pid) {
    throw new Error(`Port ${port} must be owned only by managed Bamboo ${sidecar.pid}; observed ${JSON.stringify(owners)}.`);
  }
  await waitForCondition(
    () => {
      const log = stripAnsi(`${stdout.value()}\n${stderr.value()}`);
      return (
        log.includes("selected Jiandu data root") &&
        log.includes(state.directories.jianduData) &&
        log.includes(`webview navigated to sidecar http://127.0.0.1:${port}`)
      );
    },
    {
      timeoutMs: 5_000,
      intervalMs: 50,
      label: "Jiandu selection and WebView navigation logs",
      signal: processErrors.signal,
    },
  );
  sidecar.normalizedLog = stripAnsi(`${stdout.value()}\n${stderr.value()}`);
  if (
    !sidecar.normalizedLog.includes("selected Jiandu data root") ||
    !sidecar.normalizedLog.includes('mode="explicit"') ||
    !sidecar.normalizedLog.includes(state.directories.jianduData) ||
    !sidecar.normalizedLog.includes(`webview navigated to sidecar http://127.0.0.1:${port}`)
  ) {
    throw new Error("Bodhi logs did not prove explicit Jiandu selection and WebView navigation.");
  }

  const indexResponse = await fetch(`http://127.0.0.1:${port}/index.html`, {
    signal: AbortSignal.any([processErrors.signal, AbortSignal.timeout(5_000)]),
  });
  if (indexResponse.status !== 200) {
    throw new Error(`Managed Bamboo index returned ${indexResponse.status}.`);
  }
  const indexHash = sha256(Buffer.from(await indexResponse.arrayBuffer()));
  if (indexHash !== build.receipt.files["index.html"]) {
    throw new Error(`Served Lotus Next index hash mismatch on launch ${launchNumber}.`);
  }
  return {
    appPid: child.pid,
    sidecarPid: sidecar.pid,
    port,
    indexSha256: indexHash,
    processOwnership: "direct-child",
    listenerOwnership: "exclusive",
  };
}

async function stopBodhi(state) {
  const app = state.app;
  if (!app) return null;
  if (!app.stopPromise) app.stopPromise = stopBodhiInstance(state, app);
  return await app.stopPromise;
}

async function stopBodhiInstance(state, app) {
  const appPid = app.child.pid;
  let recoveryError = null;
  if (!app.sidecarIdentity) {
    try {
      retainManagedSidecarIdentity(app);
    } catch (error) {
      recoveryError = error;
    }
  }
  let teardown = null;
  let sidecarCleanup = null;
  try {
    try {
      teardown = await terminateOwnedChild(app.child, { graceMs: 3_000, killMs: 2_000 });
      await waitForCondition(
        async () => {
          if (!app.sidecarIdentity) {
            try {
              retainManagedSidecarIdentity(app);
            } catch (error) {
              recoveryError = error;
              throw error;
            }
          }
          const actual = app.sidecarIdentity ? processIdentity(app.sidecarIdentity.pid) : null;
          return managedSidecarTeardownComplete(app.sidecarIdentity, actual, listenerOwners(app.port));
        },
        {
          timeoutMs: 10_000,
          intervalMs: 100,
          label: `managed Bamboo ${app.sidecarPid ?? "unknown"} verified teardown`,
        },
      );
    } catch (error) {
      try {
        if (!app.sidecarIdentity) {
          throw new Error(
            recoveryError instanceof Error
              ? `No verified managed sidecar identity was retained: ${recoveryError.message}`
              : "No verified managed sidecar identity was retained.",
          );
        }
        sidecarCleanup = await terminateVerifiedProcess(app.sidecarIdentity, {
          inspect: processIdentity,
          signal: (pid, signal) => process.kill(pid, signal),
          graceMs: 3_000,
          killMs: 2_000,
        });
        await waitForCondition(() => listenerOwners(app.port).length === 0, {
          timeoutMs: 2_000,
          intervalMs: 50,
          label: `managed Bamboo port ${app.port} release after verified cleanup`,
        });
      } catch (cleanupError) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} Cleanup of the exact verified sidecar also failed: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
        );
      }
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Exact verified sidecar ${app.sidecarPid} was force-cleaned (${sidecarCleanup.phase}).`,
      );
    }
    return { appPid, sidecarPid: app.sidecarPid, sidecarCleanup, teardown, listenerReleased: true };
  } finally {
    writePrivateText(
      path.join(state.directories.logs, `launch-${app.launchNumber}.log`),
      `${app.stdout.value()}\n${app.stderr.value()}`,
      [state.providerKey],
    );
    state.app = null;
  }
}

async function createProjectAndSession(baseUrl, state, signal) {
  const projectResponse = await fetchPayload(
    `${baseUrl}/api/v1/projects`,
    {
      ...jsonRequest("POST", {
        name: `Bodhi restart acceptance ${state.runId}`,
        description: "Synthetic local acceptance project",
        project_path: state.directories.project,
        workspace_bindings: [],
      }),
      signal,
    },
    [201],
  );
  const project = projectResponse.body;
  if (!project || typeof project !== "object" || typeof project.id !== "string") {
    throw new Error("Project creation did not return a stable Project id.");
  }
  const sessionResponse = await fetchPayload(
    `${baseUrl}/api/v1/sessions`,
    {
      ...jsonRequest("POST", {
        project_id: project.id,
        title: "Bodhi managed restart acceptance",
        title_generated: true,
        model: MODEL,
        provider: PROVIDER,
        model_ref: { provider: PROVIDER, model: MODEL },
        workspace_path: state.directories.project,
      }),
      signal,
    },
    [201],
  );
  const session = sessionResponse.body?.session;
  if (
    !session ||
    typeof session.id !== "string" ||
    session.project_id !== project.id ||
    session.parent_session_id !== null ||
    session.root_session_id !== session.id
  ) {
    throw new Error("Root session did not retain authoritative Project/root identity.");
  }
  return { projectId: project.id, rootSessionId: session.id };
}

async function runProviderChat(baseUrl, sessionId, marker, assistantMarker, phase, signal) {
  const response = await fetchPayload(
    `${baseUrl}/api/v1/chat`,
    {
      ...jsonRequest("POST", {
        message: marker,
        session_id: sessionId,
        model: MODEL,
        provider: PROVIDER,
        model_ref: { provider: PROVIDER, model: MODEL },
      }),
      signal,
    },
    [201],
  );
  if (response.body?.session_id !== sessionId || response.body?.status !== "streaming") {
    throw new Error(`${phase} chat did not start on the expected root session.`);
  }
  const executeResponse = await fetchPayload(
    `${baseUrl}/api/v1/execute/${encodeURIComponent(sessionId)}`,
    {
      ...jsonRequest("POST", {
        model: MODEL,
        provider: PROVIDER,
        model_ref: { provider: PROVIDER, model: MODEL },
      }),
      signal,
    },
    [202],
  );
  if (
    executeResponse.body?.session_id !== sessionId ||
    executeResponse.body?.status !== "started" ||
    typeof executeResponse.body?.run_id !== "string" ||
    !executeResponse.body.run_id ||
    executeResponse.body?.events_url !== `/api/v1/events/${sessionId}`
  ) {
    throw new Error(`${phase} execute did not start the expected root-session run.`);
  }
  await waitForHistoryMarker(baseUrl, sessionId, marker, signal);
  await waitForHistoryMarker(baseUrl, sessionId, `${assistantMarker}:${phase}`, signal);
}

function assertCompactQuery(query, memoryId, memoryBody, memoryTail) {
  const items = query?.data?.items;
  if (!Array.isArray(items)) throw new Error("Project memory query did not return a compact item list.");
  const selected = items.find((item) => item?.id === memoryId);
  if (!selected) throw new Error(`Project memory query did not return selected id ${memoryId}.`);
  const forbiddenFields = ["body", "path", "frontmatter", "keywords", "entities"];
  if (
    forbiddenFields.some((field) => Object.hasOwn(selected, field)) ||
    typeof selected.summary !== "string" ||
    selected.summary.length >= memoryBody.length ||
    JSON.stringify(selected).includes(memoryBody) ||
    JSON.stringify(selected).includes(memoryTail)
  ) {
    throw new Error("Compact Project memory query unexpectedly returned the full body.");
  }
}

async function exerciseFirstLaunch(baseUrl, state, signal) {
  const identities = await createProjectAndSession(baseUrl, state, signal);
  await runProviderChat(
    baseUrl,
    identities.rootSessionId,
    state.markers.root,
    state.markers.assistant,
    "root",
    signal,
  );

  const initialized = await executeTool(
    baseUrl,
    identities.rootSessionId,
    "memory",
    { action: "rebuild", scope: "project" },
    signal,
  );
  if (
    initialized?.action !== "rebuild" ||
    initialized?.scope !== "project" ||
    !Array.isArray(initialized?.data?.index_files) ||
    !Array.isArray(initialized?.data?.state_files)
  ) {
    throw new Error("Fresh Project memory indexes were not initialized under the canonical scope.");
  }

  const before = await executeTool(
    baseUrl,
    identities.rootSessionId,
    "memory",
    { action: "query", scope: "project", query: state.markers.memoryKeyword },
    signal,
  );
  if (!Array.isArray(before?.data?.items) || before.data.items.length !== 0) {
    throw new Error("Fresh Project unexpectedly contained the synthetic memory before write.");
  }

  const written = await executeTool(
    baseUrl,
    identities.rootSessionId,
    "memory",
    {
      action: "write",
      scope: "project",
      type: "project",
      title: `Managed restart ${state.runId}`,
      content: state.markers.memoryBody,
      tags: ["managed-restart"],
      keywords: [state.markers.memoryKeyword],
      entities: ["Bodhi", "Jiandu"],
      options: { allow_merge_if_similar: false },
    },
    signal,
  );
  const memoryId = written?.memory?.id;
  if (typeof memoryId !== "string" || !memoryId) {
    throw new Error("Native memory write did not return a stable id.");
  }

  const childResult = await executeTool(
    baseUrl,
    identities.rootSessionId,
    "SubAgent",
    {
      action: "create",
      title: "Restart persistence child",
      responsibility: "Return the deterministic child marker",
      prompt: state.markers.child,
      workspace: state.directories.project,
      auto_run: true,
      wait: false,
      model: `${PROVIDER}:${MODEL}`,
    },
    signal,
  );
  const childSessionId = childResult?.child_session_id;
  if (typeof childSessionId !== "string" || !childSessionId) {
    throw new Error("SubAgent create did not return a child Session id.");
  }
  await waitForHistoryMarker(baseUrl, childSessionId, `${state.markers.assistant}:child`, signal);

  const query = await executeTool(
    baseUrl,
    identities.rootSessionId,
    "memory",
    { action: "query", scope: "project", query: state.markers.memoryKeyword },
    signal,
  );
  assertCompactQuery(query, memoryId, state.markers.memoryBody, state.markers.memoryTail);
  const selected = await executeTool(
    baseUrl,
    identities.rootSessionId,
    "memory",
    { action: "get", id: memoryId },
    signal,
  );
  if (selected?.memory?.frontmatter?.id !== memoryId || selected?.memory?.body !== state.markers.memoryBody) {
    throw new Error("Native memory get did not return the selected stable id and full body.");
  }

  const childResponse = await fetchPayload(
    `${baseUrl}/api/v1/sessions/${encodeURIComponent(childSessionId)}`,
    { signal },
  );
  const child = childResponse.body?.session;
  if (
    !child ||
    child.parent_session_id !== identities.rootSessionId ||
    child.root_session_id !== identities.rootSessionId ||
    child.project_id !== identities.projectId
  ) {
    throw new Error("Spawned child did not preserve root Session and Project authority.");
  }
  return { ...identities, childSessionId, memoryId };
}

async function exerciseSecondLaunch(baseUrl, state, identities, signal) {
  const projectResponse = await fetchPayload(
    `${baseUrl}/api/v1/projects/${encodeURIComponent(identities.projectId)}`,
    { signal },
  );
  if (projectResponse.body?.id !== identities.projectId) {
    throw new Error("Project id was not restored on the second launch.");
  }
  const rootResponse = await fetchPayload(
    `${baseUrl}/api/v1/sessions/${encodeURIComponent(identities.rootSessionId)}`,
    { signal },
  );
  const root = rootResponse.body?.session;
  if (!root || root.project_id !== identities.projectId || root.root_session_id !== identities.rootSessionId) {
    throw new Error("Root Session/Project identity was not restored on the second launch.");
  }
  const childResponse = await fetchPayload(
    `${baseUrl}/api/v1/sessions/${encodeURIComponent(identities.childSessionId)}`,
    { signal },
  );
  const child = childResponse.body?.session;
  if (
    !child ||
    child.parent_session_id !== identities.rootSessionId ||
    child.root_session_id !== identities.rootSessionId ||
    child.project_id !== identities.projectId
  ) {
    throw new Error("Child/root/Project relationship was not restored on the second launch.");
  }

  const query = await executeTool(
    baseUrl,
    identities.rootSessionId,
    "memory",
    { action: "query", scope: "project", query: state.markers.memoryKeyword },
    signal,
  );
  assertCompactQuery(
    query,
    identities.memoryId,
    state.markers.memoryBody,
    state.markers.memoryTail,
  );
  const selected = await executeTool(
    baseUrl,
    identities.rootSessionId,
    "memory",
    { action: "get", id: identities.memoryId },
    signal,
  );
  if (
    selected?.memory?.frontmatter?.id !== identities.memoryId ||
    selected?.memory?.body !== state.markers.memoryBody
  ) {
    throw new Error("Selected Project memory did not survive the desktop restart.");
  }

  await runProviderChat(
    baseUrl,
    identities.rootSessionId,
    state.markers.restart,
    state.markers.assistant,
    "restart",
    signal,
  );
}

async function pauseForVisualEvidence(state, launchNumber, port, interrupts) {
  if (state.browserExpectations[launchNumber]) {
    throw new Error(`Launch ${launchNumber} browser challenge was already allocated.`);
  }
  const browserExpectation = {
    challenge: crypto.randomUUID(),
    title: "Bodhi",
    url: `http://127.0.0.1:${port}/`,
  };
  state.browserExpectations[launchNumber] = browserExpectation;
  console.log(`\nBODHI_ACCEPTANCE_READY launch=${launchNumber} port=${port}`);
  console.log(`Evidence root: ${state.directories.evidence}`);
  console.log(`Screenshots: ${state.directories.screenshots}`);
  console.log(`Required capture: ${path.join(state.directories.screenshots, `browser-launch-${launchNumber}.png`)}`);
  console.log(`Required receipt: ${path.join(state.directories.screenshots, `browser-launch-${launchNumber}.json`)}`);
  console.log(
    `Browser receipt: launch=${launchNumber} mode=headless url=${browserExpectation.url} title=${browserExpectation.title} challenge=${browserExpectation.challenge}`,
  );
  if (process.env.BODHI_ACCEPTANCE_AUTO_CONTINUE !== "1") {
    if (!process.stdin.isTTY) {
      throw new Error("Interactive visual acceptance requires a TTY, or set BODHI_ACCEPTANCE_AUTO_CONTINUE=1 for unattended contract runs.");
    }
    const interface = readline.createInterface({ input: process.stdin, output: process.stdout });
    await waitForInteractiveConfirmation(
      interface,
      `Capture launch ${launchNumber} evidence, then press Enter to continue… `,
      interrupts,
    );
  }
  return captureLaunchScreenshot(state, launchNumber);
}

function providerObservations(state) {
  const value = JSON.parse(fs.readFileSync(state.providerObservations, "utf8"));
  const expectedResponses = [
    ["root", "final"],
    ["child", "session_note"],
    ["child", "final"],
    ["restart", "final"],
  ];
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.requests) ||
    value.requestCount !== value.requests.length ||
    value.requests.length !== expectedResponses.length ||
    value.requests.some(
      (request, index) =>
        request.sequence !== index + 1 ||
        request.method !== "POST" ||
        request.path !== "/v1/chat/completions" ||
        request.model !== MODEL ||
        request.stream !== true ||
        request.syntheticPhase !== expectedResponses[index][0] ||
        request.responseAction !== expectedResponses[index][1],
    )
  ) {
    throw new Error("Provider observation evidence did not satisfy the redacted schema.");
  }
  assertEvidenceRedacted(value, [state.providerKey]);
  return value;
}

function launchEvidenceNames(state) {
  return fs
    .readdirSync(state.directories.screenshots, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function readLaunchScreenshot(state, launchNumber) {
  const name = `browser-launch-${launchNumber}.png`;
  const file = assertOwnedAbsolutePath(
    state.directories.screenshots,
    path.join(state.directories.screenshots, name),
    `launch ${launchNumber} screenshot`,
  );
  const metadata = fs.lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${name} must be a regular run-owned file.`);
  }
  const bytes = fs.readFileSync(file);
  return {
    name,
    sha256: sha256(bytes),
    ...pngEvidenceMetadata(bytes, name),
    fileIdentity: {
      device: metadata.dev,
      inode: metadata.ino,
      changeTimeMs: metadata.ctimeMs,
      modifiedTimeMs: metadata.mtimeMs,
    },
  };
}

function readBrowserReceipt(state, launchNumber, screenshot, timing = {}) {
  const name = `browser-launch-${launchNumber}.json`;
  const file = assertOwnedAbsolutePath(
    state.directories.screenshots,
    path.join(state.directories.screenshots, name),
    `launch ${launchNumber} browser receipt`,
  );
  const metadata = fs.lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${name} must be a regular run-owned file.`);
  }
  const bytes = fs.readFileSync(file);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${name} must contain valid JSON.`);
  }
  const expectation = state.browserExpectations[launchNumber];
  if (!expectation) throw new Error(`Launch ${launchNumber} has no run-owned browser challenge.`);
  const receipt = validateBrowserReceipt(parsed, {
    challenge: expectation.challenge,
    earliestObservedAtMs: timing.earliestObservedAtMs,
    latestObservedAtMs: timing.latestObservedAtMs,
    launchNumber,
    screenshotName: screenshot.name,
    screenshotSha256: screenshot.sha256,
    title: expectation.title,
    url: expectation.url,
  });
  return {
    ...receipt,
    receiptName: name,
    receiptSha256: sha256(bytes),
    fileIdentity: {
      device: metadata.dev,
      inode: metadata.ino,
      changeTimeMs: metadata.ctimeMs,
      modifiedTimeMs: metadata.mtimeMs,
    },
  };
}

function readLaunchEvidence(state, launchNumber, timing = {}) {
  const screenshot = readLaunchScreenshot(state, launchNumber);
  return {
    ...screenshot,
    browser: readBrowserReceipt(state, launchNumber, screenshot, timing),
  };
}

function captureLaunchScreenshot(state, launchNumber) {
  const app = state.app;
  const actualSidecar = app?.sidecarIdentity ? processIdentity(app.sidecarIdentity.pid) : null;
  if (
    !app ||
    app.launchNumber !== launchNumber ||
    app.child.exitCode !== null ||
    app.child.signalCode !== null ||
    !app.sidecarIdentity ||
    !actualSidecar ||
    actualSidecar.pid !== app.sidecarIdentity.pid ||
    actualSidecar.startedAt !== app.sidecarIdentity.startedAt ||
    actualSidecar.command !== app.sidecarIdentity.command
  ) {
    throw new Error(`Launch ${launchNumber} screenshot was not validated while its managed app was active.`);
  }
  const owners = listenerOwners(app.port);
  if (owners.length !== 1 || owners[0] !== app.sidecarIdentity.pid) {
    throw new Error(`Launch ${launchNumber} screenshot was not validated against the exclusively owned sidecar.`);
  }
  const expectedNames =
    launchNumber === 1
      ? ["browser-launch-1.json", "browser-launch-1.png"]
      : ["browser-launch-1.json", "browser-launch-1.png", "browser-launch-2.json", "browser-launch-2.png"];
  const names = launchEvidenceNames(state);
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new Error(`Launch ${launchNumber} must contain exactly ${expectedNames.join(", ")} at its validation point.`);
  }
  return {
    ...readLaunchEvidence(state, launchNumber, {
      earliestObservedAtMs: app.launchedAtMs,
      latestObservedAtMs: Date.now(),
    }),
    validatedDuringLaunch: launchNumber,
    validatedAt: new Date().toISOString(),
    appPid: app.child.pid,
    sidecarPid: app.sidecarIdentity.pid,
  };
}

function screenshotEvidence(state, captured) {
  const current = distinctLaunchScreenshots([readLaunchEvidence(state, 1), readLaunchEvidence(state, 2)]);
  const locked = distinctLaunchScreenshots(captured);
  for (let index = 0; index < locked.length; index += 1) {
    assertScreenshotEvidenceUnchanged(locked[index], current[index]);
  }
  return locked;
}

function regularFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Run-owned state contains an unexpected symlink: ${absolute}`);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute));
      else throw new Error(`Run-owned state contains a non-regular entry: ${absolute}`);
    }
  }
  return files.sort();
}

function filesContainingText(root, files, marker) {
  const needle = Buffer.from(marker, "utf8");
  return files.filter((relative) => fs.readFileSync(path.join(root, relative)).includes(needle));
}

function canonicalSessionNoteEvidence(state, childSessionId, jianduFiles) {
  const relative = path.join("memory", "v1", "sessions", childSessionId, "note", "acceptance.md");
  const file = assertOwnedAbsolutePath(state.directories.jianduData, path.join(state.directories.jianduData, relative), "child session note");
  const metadata = fs.lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("The canonical child session note is not a regular owned file.");
  }
  if (!fs.readFileSync(file).equals(Buffer.from(state.markers.sessionNote, "utf8"))) {
    throw new Error("The canonical child session note does not contain the exact successful marker.");
  }
  const matching = filesContainingText(state.directories.jianduData, jianduFiles, state.markers.sessionNote);
  if (matching.length !== 1 || matching[0] !== relative) {
    throw new Error(`The session note marker must exist only in ${relative}; observed ${JSON.stringify(matching)}.`);
  }
  return matching;
}

async function stopProvider(state) {
  if (!state.provider) return null;
  const provider = state.provider;
  if (!provider.stopPromise) provider.stopPromise = stopProviderInstance(state, provider);
  return await provider.stopPromise;
}

async function stopProviderInstance(state, provider) {
  let teardown;
  if (!Number.isInteger(provider.child.pid) && provider.processErrors?.failure) {
    teardown = {
      phase: "spawn-failed",
      exitCode: provider.child.exitCode,
      signalCode: provider.child.signalCode,
    };
  } else {
    teardown = await terminateOwnedChild(provider.child, { graceMs: 2_000, killMs: 2_000 });
  }
  writePrivateText(
    path.join(state.directories.logs, "provider.log"),
    `${provider.stdout.value()}\n${provider.stderr.value()}`,
    [state.providerKey],
  );
  if (state.provider === provider) state.provider = null;
  return teardown;
}

async function main() {
  const interrupts = installInterruptHandlers(process);
  let state = null;
  let providerTeardown = null;
  let firstStop = null;
  let secondStop = null;
  try {
    if (process.platform !== "darwin") {
      throw new Error("Managed desktop restart acceptance is intentionally macOS-only.");
    }
    const expectedBodhi = assertFullRevision(requiredEnvironment("BODHI_ACCEPTANCE_BODHI_REVISION"), "Bodhi");
    const expectedBamboo = assertFullRevision(requiredEnvironment("BODHI_ACCEPTANCE_BAMBOO_REVISION"), "Bamboo");
    state = createRuntime(expectedBodhi, expectedBamboo);
    interrupts.throwIfAborted();
    const bambooDirectory = fs.realpathSync(path.resolve(requiredEnvironment("BODHI_ACCEPTANCE_BAMBOO_DIR")));
    const artifactLock = readArtifactLock();
    interrupts.throwIfAborted();
    const bodhiIdentity = await repositoryIdentity(ROOT, expectedBodhi, "Bodhi", interrupts.signal);
    const bambooIdentity = await repositoryIdentity(
      bambooDirectory,
      expectedBamboo,
      "Bamboo",
      interrupts.signal,
    );
    interrupts.throwIfAborted();
    const build = await prepareApplication(
      bambooDirectory,
      artifactLock,
      state.directories.tmp,
      interrupts.signal,
    );
    interrupts.throwIfAborted();
    await repositoryIdentity(ROOT, expectedBodhi, "Bodhi after build", interrupts.signal);
    await repositoryIdentity(
      bambooDirectory,
      expectedBamboo,
      "Bamboo after build",
      interrupts.signal,
    );
    if (
      build.identity.sourceRevision !== artifactLock.sourceRevision ||
      build.identity.sourceDirty !== false ||
      build.identity.artifactManifestSha256 !== artifactLock.manifestSha256 ||
      build.identity.artifactResourcesSha256 !== artifactLock.resourcesSha256 ||
      build.receipt.packageName !== artifactLock.packageName ||
      build.receipt.version !== artifactLock.packageVersion
    ) {
      throw new Error("Compiled Bodhi inputs do not match the committed Lotus Next artifact lock.");
    }

    console.log(`Run-owned root: ${state.runRoot}`);
    const [providerPort, appPort] = await Promise.all([
      allocateLoopbackPort({ signal: interrupts.signal }),
      allocateLoopbackPort({ signal: interrupts.signal }),
    ]);
    if (providerPort === appPort) throw new Error("Provider and Bodhi unexpectedly selected the same port.");
    await assertLoopbackPortAvailable(providerPort, { signal: interrupts.signal });
    await assertLoopbackPortAvailable(appPort, { signal: interrupts.signal });
    writeRuntimeConfig(state, providerPort);

    const unrelatedBefore = snapshotRelevantProcesses();
    const jianduBefore = snapshotJianduProcesses();
    await startProvider(state, providerPort, interrupts.signal);

    if (launchEvidenceNames(state).length !== 0) {
      throw new Error("Screenshot evidence must be empty before the first managed launch.");
    }
    const launchOne = await startBodhi(state, build, appPort, 1, interrupts.signal);
    const identities = await exerciseFirstLaunch(
      `http://127.0.0.1:${appPort}`,
      state,
      interrupts.signal,
    );
    const launchOneScreenshot = await pauseForVisualEvidence(state, 1, appPort, interrupts);
    firstStop = await stopBodhi(state);
    interrupts.throwIfAborted();

    if (
      JSON.stringify(launchEvidenceNames(state)) !==
      JSON.stringify(["browser-launch-1.json", "browser-launch-1.png"])
    ) {
      throw new Error("Only the locked first-launch screenshot and browser receipt may exist before the second managed launch.");
    }
    assertScreenshotEvidenceUnchanged(launchOneScreenshot, readLaunchEvidence(state, 1));
    const launchTwo = await startBodhi(state, build, appPort, 2, interrupts.signal);
    if (launchTwo.appPid === launchOne.appPid || launchTwo.sidecarPid === launchOne.sidecarPid) {
      throw new Error("Second launch must have fresh Bodhi and managed Bamboo process identities.");
    }
    await exerciseSecondLaunch(
      `http://127.0.0.1:${appPort}`,
      state,
      identities,
      interrupts.signal,
    );
    const launchTwoScreenshot = await pauseForVisualEvidence(state, 2, appPort, interrupts);
    secondStop = await stopBodhi(state);
    interrupts.throwIfAborted();

    const unrelatedAfter = snapshotRelevantProcesses();
    const jianduAfter = snapshotJianduProcesses();
    if (JSON.stringify(unrelatedAfter) !== JSON.stringify(unrelatedBefore)) {
      throw new Error("A pre-existing Bamboo, Bodhi, or Nova process changed during acceptance.");
    }
    if (JSON.stringify(jianduAfter) !== JSON.stringify(jianduBefore)) {
      throw new Error("A standalone Jiandu process appeared or changed during acceptance.");
    }
    const sentinelAfter = sentinelSnapshot(state.sentinelFiles);
    if (JSON.stringify(sentinelAfter) !== JSON.stringify(state.sentinelBefore)) {
      throw new Error("A canonical fallback sentinel changed despite explicit isolated roots.");
    }
    const jianduFiles = regularFiles(state.directories.jianduData);
    if (jianduFiles.length === 0) {
      throw new Error("The explicit run-owned Jiandu root contains no persisted memory state.");
    }
    const jianduSessionNoteFiles = canonicalSessionNoteEvidence(state, identities.childSessionId, jianduFiles);
    const fallbackJiandu = path.join(state.directories.syntheticHome, ".jiandu");
    const fallbackJianduFiles = regularFiles(fallbackJiandu);
    if (filesContainingText(fallbackJiandu, fallbackJianduFiles, state.markers.sessionNote).length !== 0) {
      throw new Error("The child session_note marker leaked into the fallback Jiandu root.");
    }
    const observations = providerObservations(state);
    const screenshots = screenshotEvidence(state, [launchOneScreenshot, launchTwoScreenshot]);
    providerTeardown = await stopProvider(state);
    interrupts.throwIfAborted();

    const report = {
      schemaVersion: 1,
      status: "passed",
      runId: state.runId,
      completedAt: new Date().toISOString(),
      source: {
        bodhi: bodhiIdentity,
        bamboo: bambooIdentity,
        lotusNext: artifactLock,
        compiledExecutableSha256: sha256(fs.readFileSync(build.executable)),
        providerFixtureSha256: sha256(fs.readFileSync(state.providerScript)),
        sidecarSha256: sha256(fs.readFileSync(build.sidecar.binary)),
        bundledSidecarIdentity: build.bundledSidecarIdentity,
        targetTriple: build.triple,
      },
      runOwnedPaths: {
        root: state.runRoot,
        bambooData: state.directories.bambooData,
        jianduData: state.directories.jianduData,
        project: state.directories.project,
      },
      identities,
      launches: [
        { ...launchOne, teardown: firstStop },
        { ...launchTwo, teardown: secondStop },
      ],
      isolation: {
        explicitJianduFileCount: jianduFiles.length,
        explicitJianduSessionNoteFiles: jianduSessionNoteFiles,
        fallbackJianduSessionNoteAbsent: true,
        fallbackSentinelsUnchanged: true,
        standaloneJianduProcessesUnchanged: true,
        preExistingProcessesUnchanged: true,
        preExistingProcessSnapshot: unrelatedBefore,
      },
      provider: observations,
      providerTeardown,
      screenshots,
    };
    writePrivateJson(path.join(state.directories.evidence, "report.json"), report, [state.providerKey]);
    interrupts.throwIfAborted();
    console.log(`\nBODHI_ACCEPTANCE_PASSED report=${path.join(state.directories.evidence, "report.json")}`);
  } catch (error) {
    if (!state) throw error;
    try {
      if (state.app) await stopBodhi(state);
    } catch {
      // Preserve the primary failure; bounded teardown details are recorded below.
    }
    try {
      if (state.provider) providerTeardown = await stopProvider(state);
    } catch {
      // Preserve the primary failure.
    }
    const message = redactText(error instanceof Error ? error.stack || error.message : String(error), [state.providerKey]);
    writePrivateJson(
      path.join(state.directories.evidence, "failure.json"),
      {
        schemaVersion: 1,
        status: "failed",
        runId: state.runId,
        failedAt: new Date().toISOString(),
        error: message,
        providerTeardown,
      },
      [state.providerKey],
    );
    console.error(`BODHI_ACCEPTANCE_FAILED evidence=${state.directories.evidence}`);
    throw error;
  } finally {
    if (state?.app) {
      try {
        await stopBodhi(state);
      } catch {
        // The main result already captures the failure.
      }
    }
    if (state?.provider) {
      try {
        await stopProvider(state);
      } catch {
        // The main result already captures the failure.
      }
    }
    interrupts.dispose();
  }
}

if (process.argv.includes("--help")) {
  console.log(`Usage:
  BODHI_ACCEPTANCE_BODHI_REVISION=<40-hex> \\
  BODHI_ACCEPTANCE_BAMBOO_REVISION=<40-hex> \\
  BODHI_ACCEPTANCE_BAMBOO_DIR=<clean-absolute-checkout> \\
  npm run test:managed-restart

The command is opt-in and macOS-only. It builds the locked Lotus Next app bundle,
allocates isolated Bamboo/Jiandu/Project/provider state under one temporary root,
then pauses during each real launch so visual evidence can be captured. Set
BODHI_ACCEPTANCE_AUTO_CONTINUE=1 only for unattended contract diagnostics; a
successful acceptance report still requires distinct launch-1 and launch-2 PNGs,
each bound to an exact headless-browser URL/title/session receipt.`);
} else if (process.argv.length !== 2) {
  console.error("Unknown arguments. Use --help for the opt-in acceptance contract.");
  process.exitCode = 2;
} else {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
