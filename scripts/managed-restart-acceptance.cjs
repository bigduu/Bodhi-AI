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
  redactText,
  terminateOwnedChild,
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

function runVisible(command, args, options = {}) {
  const result = require("node:child_process").spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}.`);
  }
}

function repositoryIdentity(directory, expected, label) {
  const top = fs.realpathSync(commandText("git", ["-C", directory, "rev-parse", "--show-toplevel"]));
  if (top !== fs.realpathSync(directory)) {
    throw new Error(`${label} source must be the Git checkout root.`);
  }
  const head = commandText("git", ["-C", directory, "rev-parse", "HEAD^{commit}"]);
  assertIdentityMatches(head, expected, label);
  const status = commandText("git", [
    "-C",
    directory,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
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

function hostTriple() {
  const output = commandText("rustc", ["-vV"]);
  const match = output.match(/^host:\s*(\S+)$/mu);
  if (!match) throw new Error("rustc did not report a host target triple.");
  return match[1];
}

function prepareApplication(bambooDirectory, artifactLock) {
  console.log("Preparing the exact locked Lotus Next package and compiled Bodhi application…");
  runVisible("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: ROOT });
  runVisible(
    "npm",
    [
      "install",
      "--no-save",
      "--ignore-scripts",
      "--package-lock=false",
      `${artifactLock.packageName}@${artifactLock.packageVersion}`,
    ],
    { cwd: ROOT },
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
  runVisible("npm", ["run", "tauri", "--", "build", "--debug", "--bundles", "app"], {
    cwd: ROOT,
    env: buildEnvironment,
  });

  const source = resolveSource(buildEnvironment, ROOT);
  const identity = sourceIdentity(source);
  const receipt = verifyStaged(source, ROOT);
  const triple = hostTriple();
  const sidecar = verifySidecar(ROOT, triple);
  const bundleRoot = path.join(ROOT, "target", "debug", "bundle", "macos", "Bodhi AI.app");
  const executable = path.join(bundleRoot, "Contents", "MacOS", "bodhi");
  const bundledSidecar = path.join(bundleRoot, "Contents", "MacOS", "bamboo");
  const metadata = fs.lstatSync(executable);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size < 65_536) {
    throw new Error(`Compiled Bodhi executable is missing or invalid at ${executable}.`);
  }
  const bundledSidecarMetadata = fs.lstatSync(bundledSidecar);
  if (
    bundledSidecarMetadata.isSymbolicLink() ||
    !bundledSidecarMetadata.isFile() ||
    sha256(fs.readFileSync(bundledSidecar)) !== sha256(fs.readFileSync(sidecar.binary))
  ) {
    throw new Error("The app bundle does not contain the exact verified Bamboo sidecar.");
  }
  return { bundledSidecar, executable, identity, receipt, sidecar, triple };
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
      "project",
      "provider",
      "screenshots",
      "syntheticHome",
      "tmp",
    ].map(
      (name) => [name, assertOwnedAbsolutePath(runRoot, path.join(runRoot, name), name)],
    ),
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
  return {
    app: null,
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
      memoryBody: `confirmed project memory body ${runId}`,
      memoryKeyword: `restart-memory-${runId}`,
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

async function startProvider(state, port) {
  await assertLoopbackPortAvailable(port);
  const stdout = boundedLogCollector();
  const stderr = boundedLogCollector();
  const child = spawn("python3", [state.providerScript], {
    cwd: ROOT,
    env: {
      ...process.env,
      BODHI_ACCEPTANCE_ASSISTANT_MARKER: state.markers.assistant,
      BODHI_ACCEPTANCE_CHILD_MARKER: state.markers.child,
      BODHI_ACCEPTANCE_PROVIDER_KEY: state.providerKey,
      BODHI_ACCEPTANCE_PROVIDER_OBSERVATIONS: state.providerObservations,
      BODHI_ACCEPTANCE_PROVIDER_PORT: String(port),
      BODHI_ACCEPTANCE_RESTART_MARKER: state.markers.restart,
      BODHI_ACCEPTANCE_ROOT_MARKER: state.markers.root,
      BODHI_ACCEPTANCE_SESSION_NOTE_MARKER: state.markers.sessionNote,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.append(chunk));
  child.stderr.on("data", (chunk) => stderr.append(chunk));
  state.provider = { child, port, stdout, stderr };
  await waitForCondition(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`provider exited early: ${stderr.value()}`);
      }
      const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Authorization: `Bearer ${state.providerKey}` },
        signal: AbortSignal.timeout(1_000),
      });
      return response.status === 200 && fs.existsSync(state.providerObservations);
    },
    { timeoutMs: 15_000, intervalMs: 100, label: "deterministic provider readiness" },
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
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs ?? 5_000) });
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

async function executeTool(baseUrl, sessionId, toolName, args) {
  const parameters = Object.entries(args).map(([name, value]) => ({
    name,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
  const response = await fetchPayload(
    `${baseUrl}/api/v1/tools/execute`,
    jsonRequest("POST", { tool_name: toolName, parameters, session_id: sessionId }),
  );
  return parseToolResponse(response.body, toolName);
}

async function waitForHistoryMarker(baseUrl, sessionId, marker) {
  return await waitForCondition(
    async () => {
      const response = await fetchPayload(`${baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/history`);
      return JSON.stringify(response.body).includes(marker) ? response.body : false;
    },
    { timeoutMs: SESSION_TIMEOUT_MS, intervalMs: 200, label: `session ${sessionId} provider completion` },
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

async function startBodhi(state, build, port, launchNumber) {
  await assertLoopbackPortAvailable(port);
  const stdout = boundedLogCollector();
  const stderr = boundedLogCollector();
  const child = spawn(build.executable, [], {
    cwd: ROOT,
    env: {
      ...process.env,
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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.append(chunk));
  child.stderr.on("data", (chunk) => stderr.append(chunk));
  const app = { child, launchNumber, port, stdout, stderr, sidecarPid: null };
  state.app = app;

  await waitForCondition(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Bodhi exited before readiness: ${stderr.value()}\n${stdout.value()}`);
      }
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      return response.status === 200;
    },
    { timeoutMs: READY_TIMEOUT_MS, intervalMs: 150, label: `Bodhi launch ${launchNumber}` },
  );
  await waitForCondition(
    () => /Managed bamboo pid=\d+ port=\d+/u.test(stripAnsi(`${stdout.value()}\n${stderr.value()}`)),
    { timeoutMs: 5_000, intervalMs: 50, label: "managed sidecar identity log" },
  );

  const sidecar = managedSidecarFromLog(`${stdout.value()}\n${stderr.value()}`, port);
  app.sidecarPid = sidecar.pid;
  if (!processExists(sidecar.pid) || processParent(sidecar.pid) !== child.pid) {
    throw new Error(`Managed Bamboo ${sidecar.pid} is not a live direct child of Bodhi ${child.pid}.`);
  }
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
    { timeoutMs: 5_000, intervalMs: 50, label: "Jiandu selection and WebView navigation logs" },
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
    signal: AbortSignal.timeout(5_000),
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
  const appPid = app.child.pid;
  const sidecarPid = app.sidecarPid;
  const teardown = await terminateOwnedChild(app.child, { graceMs: 3_000, killMs: 2_000 });
  if (sidecarPid) {
    await waitForCondition(
      async () => !processExists(sidecarPid) && listenerOwners(app.port).length === 0,
      { timeoutMs: 10_000, intervalMs: 100, label: `managed Bamboo ${sidecarPid} teardown` },
    );
  }
  writePrivateText(
    path.join(state.directories.logs, `launch-${app.launchNumber}.log`),
    `${app.stdout.value()}\n${app.stderr.value()}`,
    [state.providerKey],
  );
  state.app = null;
  return { appPid, sidecarPid, teardown, listenerReleased: true };
}

async function createProjectAndSession(baseUrl, state) {
  const projectResponse = await fetchPayload(
    `${baseUrl}/api/v1/projects`,
    jsonRequest("POST", {
      name: `Bodhi restart acceptance ${state.runId}`,
      description: "Synthetic local acceptance project",
      project_path: state.directories.project,
      workspace_bindings: [],
    }),
    [201],
  );
  const project = projectResponse.body;
  if (!project || typeof project !== "object" || typeof project.id !== "string") {
    throw new Error("Project creation did not return a stable Project id.");
  }
  const sessionResponse = await fetchPayload(
    `${baseUrl}/api/v1/sessions`,
    jsonRequest("POST", {
      project_id: project.id,
      title: "Bodhi managed restart acceptance",
      title_generated: true,
      model: MODEL,
      provider: PROVIDER,
      model_ref: { provider: PROVIDER, model: MODEL },
      workspace_path: state.directories.project,
    }),
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

async function runProviderChat(baseUrl, sessionId, marker, assistantMarker, phase) {
  const response = await fetchPayload(
    `${baseUrl}/api/v1/chat`,
    jsonRequest("POST", {
      message: marker,
      session_id: sessionId,
      model: MODEL,
      provider: PROVIDER,
      model_ref: { provider: PROVIDER, model: MODEL },
    }),
  );
  if (response.body?.session_id !== sessionId || response.body?.status !== "streaming") {
    throw new Error(`${phase} chat did not start on the expected root session.`);
  }
  await waitForHistoryMarker(baseUrl, sessionId, marker);
  await waitForHistoryMarker(baseUrl, sessionId, `${assistantMarker}:${phase}`);
}

function assertCompactQuery(query, memoryId, memoryBody) {
  const items = query?.data?.items;
  if (!Array.isArray(items)) throw new Error("Project memory query did not return a compact item list.");
  const selected = items.find((item) => item?.id === memoryId);
  if (!selected) throw new Error(`Project memory query did not return selected id ${memoryId}.`);
  if (Object.hasOwn(selected, "body") || JSON.stringify(selected).includes(memoryBody)) {
    throw new Error("Compact Project memory query unexpectedly returned the full body.");
  }
}

async function exerciseFirstLaunch(baseUrl, state) {
  const identities = await createProjectAndSession(baseUrl, state);
  await runProviderChat(
    baseUrl,
    identities.rootSessionId,
    state.markers.root,
    state.markers.assistant,
    "root",
  );

  const before = await executeTool(baseUrl, identities.rootSessionId, "memory", {
    action: "query",
    scope: "project",
    query: state.markers.memoryKeyword,
  });
  if (!Array.isArray(before?.data?.items) || before.data.items.length !== 0) {
    throw new Error("Fresh Project unexpectedly contained the synthetic memory before write.");
  }

  const written = await executeTool(baseUrl, identities.rootSessionId, "memory", {
    action: "write",
    scope: "project",
    type: "project",
    title: `Managed restart ${state.runId}`,
    content: state.markers.memoryBody,
    tags: ["managed-restart"],
    keywords: [state.markers.memoryKeyword],
    entities: ["Bodhi", "Jiandu"],
    options: { allow_merge_if_similar: false },
  });
  const memoryId = written?.memory?.id;
  if (typeof memoryId !== "string" || !memoryId) {
    throw new Error("Native memory write did not return a stable id.");
  }

  const childResult = await executeTool(baseUrl, identities.rootSessionId, "SubAgent", {
    action: "create",
    title: "Restart persistence child",
    responsibility: "Return the deterministic child marker",
    prompt: state.markers.child,
    workspace: state.directories.project,
    auto_run: true,
    wait: false,
    model: `${PROVIDER}:${MODEL}`,
  });
  const childSessionId = childResult?.child_session_id;
  if (typeof childSessionId !== "string" || !childSessionId) {
    throw new Error("SubAgent create did not return a child Session id.");
  }
  await waitForHistoryMarker(baseUrl, childSessionId, `${state.markers.assistant}:child`);

  const query = await executeTool(baseUrl, identities.rootSessionId, "memory", {
    action: "query",
    scope: "project",
    query: state.markers.memoryKeyword,
  });
  assertCompactQuery(query, memoryId, state.markers.memoryBody);
  const selected = await executeTool(baseUrl, identities.rootSessionId, "memory", {
    action: "get",
    id: memoryId,
  });
  if (selected?.memory?.frontmatter?.id !== memoryId || selected?.memory?.body !== state.markers.memoryBody) {
    throw new Error("Native memory get did not return the selected stable id and full body.");
  }

  const childResponse = await fetchPayload(`${baseUrl}/api/v1/sessions/${encodeURIComponent(childSessionId)}`);
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

async function exerciseSecondLaunch(baseUrl, state, identities) {
  const projectResponse = await fetchPayload(`${baseUrl}/api/v1/projects/${encodeURIComponent(identities.projectId)}`);
  if (projectResponse.body?.id !== identities.projectId) {
    throw new Error("Project id was not restored on the second launch.");
  }
  const rootResponse = await fetchPayload(`${baseUrl}/api/v1/sessions/${encodeURIComponent(identities.rootSessionId)}`);
  const root = rootResponse.body?.session;
  if (!root || root.project_id !== identities.projectId || root.root_session_id !== identities.rootSessionId) {
    throw new Error("Root Session/Project identity was not restored on the second launch.");
  }
  const childResponse = await fetchPayload(`${baseUrl}/api/v1/sessions/${encodeURIComponent(identities.childSessionId)}`);
  const child = childResponse.body?.session;
  if (
    !child ||
    child.parent_session_id !== identities.rootSessionId ||
    child.root_session_id !== identities.rootSessionId ||
    child.project_id !== identities.projectId
  ) {
    throw new Error("Child/root/Project relationship was not restored on the second launch.");
  }

  const query = await executeTool(baseUrl, identities.rootSessionId, "memory", {
    action: "query",
    scope: "project",
    query: state.markers.memoryKeyword,
  });
  assertCompactQuery(query, identities.memoryId, state.markers.memoryBody);
  const selected = await executeTool(baseUrl, identities.rootSessionId, "memory", {
    action: "get",
    id: identities.memoryId,
  });
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
  );
}

async function pauseForVisualEvidence(state, launchNumber, port) {
  console.log(`\nBODHI_ACCEPTANCE_READY launch=${launchNumber} port=${port}`);
  console.log(`Evidence root: ${state.directories.evidence}`);
  console.log(`Screenshots: ${state.directories.screenshots}`);
  if (process.env.BODHI_ACCEPTANCE_AUTO_CONTINUE === "1") return;
  if (!process.stdin.isTTY) {
    throw new Error("Interactive visual acceptance requires a TTY, or set BODHI_ACCEPTANCE_AUTO_CONTINUE=1 for unattended contract runs.");
  }
  const interface = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => interface.question(`Capture launch ${launchNumber} evidence, then press Enter to continue… `, resolve));
  interface.close();
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

function screenshotEvidence(state) {
  return fs
    .readdirSync(state.directories.screenshots, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.png$/iu.test(entry.name))
    .map((entry) => {
      const file = path.join(state.directories.screenshots, entry.name);
      return { name: entry.name, sha256: sha256(fs.readFileSync(file)), size: fs.statSync(file).size };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
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

async function stopProvider(state) {
  if (!state.provider) return null;
  const provider = state.provider;
  const teardown = await terminateOwnedChild(provider.child, { graceMs: 2_000, killMs: 2_000 });
  writePrivateText(
    path.join(state.directories.logs, "provider.log"),
    `${provider.stdout.value()}\n${provider.stderr.value()}`,
    [state.providerKey],
  );
  state.provider = null;
  return teardown;
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("Managed desktop restart acceptance is intentionally macOS-only.");
  }
  const expectedBodhi = assertFullRevision(requiredEnvironment("BODHI_ACCEPTANCE_BODHI_REVISION"), "Bodhi");
  const expectedBamboo = assertFullRevision(requiredEnvironment("BODHI_ACCEPTANCE_BAMBOO_REVISION"), "Bamboo");
  const bambooDirectory = fs.realpathSync(path.resolve(requiredEnvironment("BODHI_ACCEPTANCE_BAMBOO_DIR")));
  const artifactLock = readArtifactLock();
  const bodhiIdentity = repositoryIdentity(ROOT, expectedBodhi, "Bodhi");
  const bambooIdentity = repositoryIdentity(bambooDirectory, expectedBamboo, "Bamboo");
  const build = prepareApplication(bambooDirectory, artifactLock);
  repositoryIdentity(ROOT, expectedBodhi, "Bodhi after build");
  repositoryIdentity(bambooDirectory, expectedBamboo, "Bamboo after build");
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

  const state = createRuntime(expectedBodhi, expectedBamboo);
  console.log(`Run-owned root: ${state.runRoot}`);
  let providerTeardown = null;
  let firstStop = null;
  let secondStop = null;
  try {
    const [providerPort, appPort] = await Promise.all([allocateLoopbackPort(), allocateLoopbackPort()]);
    if (providerPort === appPort) throw new Error("Provider and Bodhi unexpectedly selected the same port.");
    await assertLoopbackPortAvailable(providerPort);
    await assertLoopbackPortAvailable(appPort);
    writeRuntimeConfig(state, providerPort);

    const unrelatedBefore = snapshotRelevantProcesses();
    const jianduBefore = snapshotJianduProcesses();
    await startProvider(state, providerPort);

    const launchOne = await startBodhi(state, build, appPort, 1);
    const identities = await exerciseFirstLaunch(`http://127.0.0.1:${appPort}`, state);
    await pauseForVisualEvidence(state, 1, appPort);
    firstStop = await stopBodhi(state);

    const launchTwo = await startBodhi(state, build, appPort, 2);
    if (launchTwo.appPid === launchOne.appPid || launchTwo.sidecarPid === launchOne.sidecarPid) {
      throw new Error("Second launch must have fresh Bodhi and managed Bamboo process identities.");
    }
    await exerciseSecondLaunch(`http://127.0.0.1:${appPort}`, state, identities);
    await pauseForVisualEvidence(state, 2, appPort);
    secondStop = await stopBodhi(state);

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
    const jianduSessionNoteFiles = filesContainingText(
      state.directories.jianduData,
      jianduFiles,
      state.markers.sessionNote,
    );
    if (jianduSessionNoteFiles.length === 0) {
      throw new Error("The child session_note marker was not persisted in the explicit Jiandu root.");
    }
    const fallbackJiandu = path.join(state.directories.syntheticHome, ".jiandu");
    const fallbackJianduFiles = regularFiles(fallbackJiandu);
    if (filesContainingText(fallbackJiandu, fallbackJianduFiles, state.markers.sessionNote).length !== 0) {
      throw new Error("The child session_note marker leaked into the fallback Jiandu root.");
    }
    const observations = providerObservations(state);
    const screenshots = screenshotEvidence(state);
    if (
      !screenshots.some((entry) => entry.name.includes("launch-1")) ||
      !screenshots.some((entry) => entry.name.includes("launch-2"))
    ) {
      throw new Error("Visual evidence must include at least one PNG for each real launch.");
    }
    providerTeardown = await stopProvider(state);

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
    console.log(`\nBODHI_ACCEPTANCE_PASSED report=${path.join(state.directories.evidence, "report.json")}`);
  } catch (error) {
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
    if (state.app) {
      try {
        await stopBodhi(state);
      } catch {
        // The main result already captures the failure.
      }
    }
    if (state.provider) {
      try {
        await stopProvider(state);
      } catch {
        // The main result already captures the failure.
      }
    }
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
successful acceptance report still requires launch-1 and launch-2 PNG evidence.`);
} else if (process.argv.length !== 2) {
  console.error("Unknown arguments. Use --help for the opt-in acceptance contract.");
  process.exitCode = 2;
} else {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
