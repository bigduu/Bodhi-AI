const net = require("node:net");
const path = require("node:path");

const FULL_GIT_REVISION = /^[0-9a-f]{40}$/u;
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
  isolatedChildEnvironment,
  redactText,
  terminateOwnedChild,
  waitForCondition,
};
