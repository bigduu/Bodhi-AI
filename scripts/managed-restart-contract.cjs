const net = require("node:net");
const path = require("node:path");

const FULL_GIT_REVISION = /^[0-9a-f]{40}$/u;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const CONTROLLED_ENV_PREFIX =
  /^(?:AWS|AZURE|BAMBOO|BODHI|CARGO|CLAUDE|CODEX|COPILOT|DEEPSEEK|DYLD|GEMINI|GH|GIT|GITHUB|GOOGLE|JIANDU|LOTUS|MCP|NODE|NPM|OPENAI|PYTHON|RUST|SSH|VITE)_/u;
const CONTROLLED_ENV_NAMES = new Set([
  "ALL_PROXY",
  "CURL_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LD_PRELOAD",
  "NO_PROXY",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
]);
const CREDENTIAL_ENV_NAME = /(?:^|_)(?:API_KEY|ACCESS_KEY|PRIVATE_KEY|AUTH|COOKIE|CREDENTIALS?|PASSWD|PASSWORD|SECRET|TOKEN)(?:_|$)/u;

function assertFullRevision(value, label) {
  if (typeof value !== "string" || !FULL_GIT_REVISION.test(value)) {
    throw new Error(`${label} must be an exact 40-character lowercase Git revision.`);
  }
  return value;
}

function assertIdentityMatches(actual, expected, label) {
  assertFullRevision(actual, `${label} actual revision`);
  assertFullRevision(expected, `${label} expected revision`);
  if (actual !== expected) {
    throw new Error(`${label} revision mismatch: expected ${expected}, found ${actual}.`);
  }
  return actual;
}

function assertOwnedAbsolutePath(ownerRoot, candidate, label) {
  if (!path.isAbsolute(ownerRoot) || !path.isAbsolute(candidate)) {
    throw new Error(`${label} and its owner root must both be absolute paths.`);
  }
  const relative = path.relative(path.resolve(ownerRoot), path.resolve(candidate));
  if (relative === "" || relative === ".") return path.resolve(candidate);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain inside the run-owned root.`);
  }
  return path.resolve(candidate);
}

function assertTcpPort(port, label = "port") {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer between 1 and 65535.`);
  }
  return port;
}

function isolatedChildEnvironment(source, overrides = {}) {
  const environment = {};
  for (const [name, value] of Object.entries(source || {})) {
    if (typeof value !== "string") continue;
    const normalized = name.toUpperCase();
    if (
      CONTROLLED_ENV_NAMES.has(normalized) ||
      CONTROLLED_ENV_PREFIX.test(normalized) ||
      CREDENTIAL_ENV_NAME.test(normalized)
    ) {
      continue;
    }
    environment[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (typeof value !== "string") {
      throw new Error(`Isolated child environment override ${name} must be a string.`);
    }
    environment[name] = value;
  }
  return environment;
}

async function assertLoopbackPortAvailable(port) {
  assertTcpPort(port);
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    const finish = (error) => {
      server.removeAllListeners();
      if (error) reject(error);
      else resolve();
    };
    server.once("error", () => {
      finish(new Error(`Loopback port ${port} is already occupied.`));
    });
    server.once("listening", () => {
      server.close((error) => finish(error || null));
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
}

async function allocateLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a numeric loopback port."));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  });
}

async function waitForCondition(check, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 100;
  const label = options.label ?? "condition";
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("wait timeout must be a positive integer.");
  }
  const deadline = Date.now() + timeoutMs;
  let lastFailure;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastFailure = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const detail = lastFailure instanceof Error ? ` Last failure: ${lastFailure.message}` : "";
  throw new Error(`${label} did not complete within ${timeoutMs}ms.${detail}`);
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ exitCode: child.exitCode, signalCode: child.signalCode });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", finish);
      resolve(
        child.exitCode !== null || child.signalCode !== null
          ? { exitCode: child.exitCode, signalCode: child.signalCode }
          : null,
      );
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    child.once("exit", finish);
  });
}

async function terminateOwnedChild(child, options = {}) {
  const graceMs = options.graceMs ?? 2_000;
  const killMs = options.killMs ?? 2_000;
  if (!child || !Number.isInteger(child.pid) || child.pid < 1) {
    throw new Error("An exact spawned child process is required for teardown.");
  }
  const alreadyExited = await waitForChildExit(child, 1);
  if (alreadyExited) return { phase: "already-exited", ...alreadyExited };

  child.kill("SIGTERM");
  const graceful = await waitForChildExit(child, graceMs);
  if (graceful) return { phase: "sigterm", ...graceful };

  child.kill("SIGKILL");
  const forced = await waitForChildExit(child, killMs);
  if (!forced) {
    throw new Error(`Owned process ${child.pid} did not exit within the bounded teardown.`);
  }
  return { phase: "sigkill", ...forced };
}

function assertSameProcessIdentity(actual, expected) {
  if (
    !actual ||
    actual.pid !== expected.pid ||
    actual.startedAt !== expected.startedAt ||
    actual.command !== expected.command
  ) {
    throw new Error(`Refusing to signal PID ${expected.pid} because its verified process identity changed.`);
  }
}

async function terminateVerifiedProcess(expected, options = {}) {
  const inspect = options.inspect;
  const signal = options.signal;
  const graceMs = options.graceMs ?? 2_000;
  const killMs = options.killMs ?? 2_000;
  const intervalMs = options.intervalMs ?? 25;
  if (
    !expected ||
    !Number.isInteger(expected.pid) ||
    expected.pid < 1 ||
    typeof expected.startedAt !== "string" ||
    !expected.startedAt ||
    typeof expected.command !== "string" ||
    !expected.command ||
    typeof inspect !== "function" ||
    typeof signal !== "function"
  ) {
    throw new Error("An exact process identity plus inspect and signal functions are required for teardown.");
  }

  const waitForExit = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    do {
      const actual = await inspect(expected.pid);
      if (actual === null) return true;
      assertSameProcessIdentity(actual, expected);
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, deadline - Date.now())));
    } while (true);
  };

  const actual = await inspect(expected.pid);
  if (actual === null) return { phase: "already-exited", pid: expected.pid };
  assertSameProcessIdentity(actual, expected);
  signal(expected.pid, "SIGTERM");
  if (await waitForExit(graceMs)) return { phase: "sigterm", pid: expected.pid };
  signal(expected.pid, "SIGKILL");
  if (await waitForExit(killMs)) return { phase: "sigkill", pid: expected.pid };
  throw new Error(`Verified process ${expected.pid} did not exit within the bounded teardown.`);
}

function pngEvidenceMetadata(bytes, label = "PNG evidence") {
  if (!Buffer.isBuffer(bytes) || bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${label} is not a valid PNG file.`);
  }
  const ihdrLength = bytes.readUInt32BE(8);
  const ihdrType = bytes.subarray(12, 16).toString("ascii");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (ihdrLength !== 13 || ihdrType !== "IHDR" || width < 320 || height < 200 || bytes.length < 1_024) {
    throw new Error(`${label} does not have usable screenshot dimensions or content.`);
  }

  let offset = 8;
  let sawImageData = false;
  let sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw new Error(`${label} contains a truncated PNG chunk.`);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT" && length > 0) sawImageData = true;
    offset += length + 12;
    if (type === "IEND") {
      if (length !== 0 || offset !== bytes.length) throw new Error(`${label} has an invalid PNG terminator.`);
      sawEnd = true;
      break;
    }
  }
  if (!sawImageData || !sawEnd) throw new Error(`${label} is missing encoded image data.`);
  return { height, size: bytes.length, width };
}

function distinctLaunchScreenshots(screenshots) {
  if (!Array.isArray(screenshots)) throw new Error("Screenshot evidence must be an array.");
  const expectedNames = ["browser-launch-1.png", "browser-launch-2.png"];
  const selected = expectedNames.map((name) => screenshots.find((entry) => entry?.name === name));
  if (selected.some((entry) => !entry || !/^[0-9a-f]{64}$/u.test(entry.sha256))) {
    throw new Error(`Visual evidence must include separate exact files: ${expectedNames.join(", ")}.`);
  }
  if (selected[0].sha256 === selected[1].sha256) {
    throw new Error("The two launch screenshots must contain distinct captured bytes.");
  }
  return selected;
}

function redactText(value, secrets) {
  let redacted = String(value);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redacted;
}

function assertEvidenceRedacted(value, secrets) {
  const encoded = JSON.stringify(value);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0 && encoded.includes(secret)) {
      throw new Error("Evidence contains a value designated as secret.");
    }
  }
  return value;
}

module.exports = {
  allocateLoopbackPort,
  assertEvidenceRedacted,
  assertFullRevision,
  assertIdentityMatches,
  assertLoopbackPortAvailable,
  assertOwnedAbsolutePath,
  assertTcpPort,
  distinctLaunchScreenshots,
  isolatedChildEnvironment,
  pngEvidenceMetadata,
  redactText,
  terminateOwnedChild,
  terminateVerifiedProcess,
  waitForCondition,
};
