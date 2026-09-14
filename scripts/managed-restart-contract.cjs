const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const zlib = require("node:zlib");

const FULL_GIT_REVISION = /^[0-9a-f]{40}$/u;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const CONTROLLED_ENV_PREFIX =
  /^(?:PYTHON|(?:AWS|AZURE|BAMBOO|BODHI|CARGO|CLAUDE|CODEX|COPILOT|DEEPSEEK|DYLD|GEMINI|GH|GIT|GITHUB|GOOGLE|JIANDU|LOTUS|MCP|NODE|NPM|OPENAI|RUST|SSH|VITE)_)/u;
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
const MAX_PNG_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PNG_DECODED_BYTES = 128 * 1024 * 1024;
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

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

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted.");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function delayWithSignal(delayMs, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function delay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function observeChildProcessErrors(child, label, parentSignal, onError = () => {}) {
  if (
    typeof child?.on !== "function" ||
    typeof label !== "string" ||
    !label ||
    typeof onError !== "function"
  ) {
    throw new Error("Child process error observation requires a process and label.");
  }
  const controller = new AbortController();
  let failure = null;
  child.on("error", (error) => {
    if (failure) return;
    failure = new Error(
      `${label} process error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
    controller.abort(failure);
    try {
      onError(failure);
    } catch {
      // Reporting must never turn a captured process error back into an uncaught event.
    }
  });
  return {
    get failure() {
      return failure;
    },
    signal: parentSignal
      ? AbortSignal.any([parentSignal, controller.signal])
      : controller.signal,
  };
}

async function assertLoopbackPortAvailable(port, options = {}) {
  assertTcpPort(port);
  const signal = options.signal;
  throwIfAborted(signal);
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    let aborted = false;
    let closing = false;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      server.removeAllListeners();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      aborted = true;
      if (server.listening) closeServer();
    };
    const closeServer = () => {
      if (closing) return;
      closing = true;
      server.close((error) => finish(aborted ? abortReason(signal) : error || null));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    server.once("error", () => {
      finish(aborted ? abortReason(signal) : new Error(`Loopback port ${port} is already occupied.`));
    });
    server.once("listening", () => {
      closeServer();
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
}

async function allocateLoopbackPort(options = {}) {
  const signal = options.signal;
  throwIfAborted(signal);
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    let aborted = false;
    let closing = false;
    let settled = false;
    let allocatedPort = null;
    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      server.removeAllListeners();
      if (error) reject(error);
      else resolve(port);
    };
    const onAbort = () => {
      aborted = true;
      if (server.listening) closeServer();
    };
    const closeServer = () => {
      if (closing) return;
      closing = true;
      server.close((error) => finish(aborted ? abortReason(signal) : error || null, allocatedPort));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    server.once("error", (error) => finish(aborted ? abortReason(signal) : error));
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        closing = true;
        server.close(() => finish(new Error("Could not allocate a numeric loopback port.")));
        return;
      }
      allocatedPort = address.port;
      closeServer();
    });
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  });
}

async function waitForCondition(check, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 100;
  const label = options.label ?? "condition";
  const signal = options.signal;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("wait timeout must be a positive integer.");
  }
  const deadline = Date.now() + timeoutMs;
  let lastFailure;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      const result = await check();
      throwIfAborted(signal);
      if (result) return result;
    } catch (error) {
      throwIfAborted(signal);
      lastFailure = error;
    }
    await delayWithSignal(intervalMs, signal);
  }
  throwIfAborted(signal);
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

function processGroupExists(groupId) {
  if (process.platform === "win32") return false;
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function signalOwnedProcessGroup(child, signalName, detached) {
  if (detached && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signalName);
      return true;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  if (child.exitCode === null && child.signalCode === null) return child.kill(signalName);
  return false;
}

async function waitForOwnedProcessGroupExit(child, detached, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const childExited = child.exitCode !== null || child.signalCode !== null;
    const groupExited = !detached || !processGroupExists(child.pid);
    if (childExited && groupExited) {
      return { exitCode: child.exitCode, signalCode: child.signalCode };
    }
    if (Date.now() >= deadline) return null;
    await delay(Math.min(25, deadline - Date.now()));
  } while (true);
}

async function terminateOwnedProcessGroup(child, options = {}) {
  const detached = options.detached === true && process.platform !== "win32";
  const graceMs = options.graceMs ?? 3_000;
  const killMs = options.killMs ?? 2_000;
  if (!child || !Number.isInteger(child.pid) || child.pid < 1) {
    throw new Error("An exact spawned command process is required for teardown.");
  }

  const alreadyExited = await waitForOwnedProcessGroupExit(child, detached, 1);
  if (alreadyExited) return { phase: "already-exited", ...alreadyExited };

  signalOwnedProcessGroup(child, "SIGTERM", detached);
  const graceful = await waitForOwnedProcessGroupExit(child, detached, graceMs);
  if (graceful) return { phase: "sigterm", ...graceful };

  signalOwnedProcessGroup(child, "SIGKILL", detached);
  const forced = await waitForOwnedProcessGroupExit(child, detached, killMs);
  if (!forced) {
    throw new Error(`Owned command process group ${child.pid} did not exit within the bounded teardown.`);
  }
  return { phase: "sigkill", ...forced };
}

async function runInterruptibleCommand(command, args, options = {}) {
  if (typeof command !== "string" || !command || !Array.isArray(args)) {
    throw new Error("An exact command and argument array are required.");
  }
  const signal = options.signal;
  throwIfAborted(signal);
  const detached = process.platform !== "win32";
  const visible = options.visible === true;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new Error("Command output limit must be a positive integer.");
  }

  const child = spawn(command, args, {
    cwd: options.cwd,
    detached,
    env: options.env,
    stdio: visible ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const append = (current, chunk) => {
    const combined = current + chunk.toString("utf8");
    if (Buffer.byteLength(combined) <= maxOutputBytes) return combined;
    return `[earlier output truncated]\n${combined.slice(-Math.floor(maxOutputBytes / 2))}`;
  };
  child.stdout?.on("data", (chunk) => {
    stdout = append(stdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = append(stderr, chunk);
  });

  let abortTask = null;
  let notifyAbort;
  const abortNotification = new Promise((resolve) => {
    notifyAbort = resolve;
  });
  const onAbort = () => {
    if (!abortTask && Number.isInteger(child.pid)) {
      abortTask = terminateOwnedProcessGroup(child, {
        detached,
        graceMs: options.graceMs,
        killMs: options.killMs,
      });
      abortTask.catch(() => {});
      notifyAbort();
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  const closePromise = new Promise((resolve) => {
    child.once("close", (exitCode, signalCode) => resolve({ exitCode, signalCode }));
  });
  const firstSettlement = await Promise.race([
    closePromise.then((result) => ({ kind: "closed", result })),
    abortNotification.then(() => ({ kind: "aborted" })),
  ]);
  if (firstSettlement.kind === "aborted") {
    try {
      await abortTask;
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      throw new Error(
        `${abortReason(signal).message} Owned command cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    await closePromise;
    signal?.removeEventListener("abort", onAbort);
    throw abortReason(signal);
  }
  const result = firstSettlement.result;
  signal?.removeEventListener("abort", onAbort);

  if (abortTask) {
    await abortTask;
    throw abortReason(signal);
  }
  if (spawnError) throw spawnError;
  if (signal?.aborted) throw abortReason(signal);

  const groupSettlement = await waitForOwnedProcessGroupExit(child, detached, 250);
  if (!groupSettlement) {
    const cleanup = await terminateOwnedProcessGroup(child, {
      detached,
      graceMs: options.graceMs,
      killMs: options.killMs,
    });
    throw new Error(
      `${command} left an owned descendant process after exiting; it was cleaned up with ${cleanup.phase}.`,
    );
  }
  throwIfAborted(signal);
  if (result.exitCode !== 0) {
    const detail = stderr.trim() ? `: ${stderr.trim().slice(-2_000)}` : "";
    throw new Error(
      `${command} exited with ${result.signalCode ? `signal ${result.signalCode}` : `status ${result.exitCode}`}${detail}`,
    );
  }
  return { ...result, pid: child.pid, stderr, stdout };
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

function managedSidecarTeardownComplete(expected, actual, listenerPids) {
  if (!Array.isArray(listenerPids)) {
    throw new Error("Managed sidecar listener ownership must be an array.");
  }
  if (!expected) return false;
  if (actual !== null) {
    assertSameProcessIdentity(actual, expected);
    return false;
  }
  return listenerPids.length === 0;
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

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function paethPredictor(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodePngScanlines(compressed, width, height, channels, label) {
  const rowBytes = width * channels;
  const decodedBytes = (rowBytes + 1) * height;
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes > MAX_PNG_DECODED_BYTES) {
    throw new Error(`${label} has unsafe decoded image dimensions.`);
  }
  let encoded;
  try {
    encoded = zlib.inflateSync(compressed, { maxOutputLength: decodedBytes + 1 });
  } catch {
    throw new Error(`${label} contains undecodable PNG image data.`);
  }
  if (encoded.length !== decodedBytes) {
    throw new Error(`${label} decoded to an unexpected scanline length.`);
  }

  let previous = Buffer.alloc(rowBytes);
  let sourceOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = encoded[sourceOffset];
    sourceOffset += 1;
    if (filter > 4) throw new Error(`${label} contains an invalid PNG scanline filter.`);
    const current = Buffer.allocUnsafe(rowBytes);
    for (let column = 0; column < rowBytes; column += 1) {
      const source = encoded[sourceOffset];
      sourceOffset += 1;
      const left = column >= channels ? current[column - channels] : 0;
      const above = previous[column];
      const upperLeft = column >= channels ? previous[column - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) predictor = paethPredictor(left, above, upperLeft);
      current[column] = (source + predictor) & 0xff;
    }
    previous = current;
  }
}

function pngEvidenceMetadata(bytes, label = "PNG evidence") {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 45 ||
    bytes.length > MAX_PNG_FILE_BYTES ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
  ) {
    throw new Error(`${label} is not a valid PNG file.`);
  }

  let offset = 8;
  let width = null;
  let height = null;
  let channels = null;
  let sawHeader = false;
  let sawImageData = false;
  let endedImageData = false;
  let sawEnd = false;
  const imageData = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw new Error(`${label} contains a truncated PNG chunk.`);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (!/^[A-Za-z]{4}$/u.test(type)) throw new Error(`${label} contains an invalid PNG chunk type.`);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    const actualCrc = crc32(bytes.subarray(offset + 4, dataEnd));
    if (actualCrc !== expectedCrc) throw new Error(`${label} contains a PNG chunk with an invalid CRC.`);

    if (!sawHeader && type !== "IHDR") throw new Error(`${label} does not begin with a PNG header.`);
    if (type === "IHDR") {
      if (sawHeader || offset !== 8 || length !== 13) throw new Error(`${label} has an invalid PNG header.`);
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      const bitDepth = bytes[dataStart + 8];
      const colorType = bytes[dataStart + 9];
      const compression = bytes[dataStart + 10];
      const filter = bytes[dataStart + 11];
      const interlace = bytes[dataStart + 12];
      channels = new Map([
        [0, 1],
        [2, 3],
        [4, 2],
        [6, 4],
      ]).get(colorType);
      if (
        width < 320 ||
        height < 200 ||
        width > 16_384 ||
        height > 16_384 ||
        bytes.length < 1_024 ||
        bitDepth !== 8 ||
        channels === undefined ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        throw new Error(`${label} does not have supported screenshot dimensions or encoding.`);
      }
      sawHeader = true;
    } else if (type === "IDAT") {
      if (!sawHeader || sawEnd || endedImageData) throw new Error(`${label} has invalid PNG image-data ordering.`);
      if (length > 0) {
        imageData.push(bytes.subarray(dataStart, dataEnd));
        sawImageData = true;
      }
    } else {
      if (sawImageData && type !== "IEND") endedImageData = true;
      if (type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90 && type !== "PLTE" && type !== "IEND") {
        throw new Error(`${label} contains an unsupported critical PNG chunk.`);
      }
    }
    offset = dataEnd + 4;
    if (type === "IEND") {
      if (length !== 0 || offset !== bytes.length) throw new Error(`${label} has an invalid PNG terminator.`);
      sawEnd = true;
      break;
    }
  }
  if (!sawHeader || !sawImageData || !sawEnd) throw new Error(`${label} is missing encoded image data.`);
  decodePngScanlines(Buffer.concat(imageData), width, height, channels, label);
  return { height, size: bytes.length, width };
}

function distinctLaunchScreenshots(screenshots) {
  if (!Array.isArray(screenshots)) throw new Error("Screenshot evidence must be an array.");
  const expectedNames = ["browser-launch-1.png", "browser-launch-2.png"];
  if (screenshots.length !== expectedNames.length) {
    throw new Error(`Visual evidence must contain only the two separate exact files: ${expectedNames.join(", ")}.`);
  }
  const selected = expectedNames.map((name) => screenshots.find((entry) => entry?.name === name));
  if (selected.some((entry) => !entry || !/^[0-9a-f]{64}$/u.test(entry.sha256))) {
    throw new Error(`Visual evidence must include separate exact files: ${expectedNames.join(", ")}.`);
  }
  if (selected[0].sha256 === selected[1].sha256) {
    throw new Error("The two launch screenshots must contain distinct captured bytes.");
  }
  for (let index = 0; index < selected.length; index += 1) {
    const screenshot = selected[index];
    const launchNumber = index + 1;
    const expectedReceiptName = `browser-launch-${launchNumber}.json`;
    if (
      screenshot.browser?.schemaVersion !== 1 ||
      screenshot.browser?.captureTool !== "agent-browser" ||
      screenshot.browser?.mode !== "headless" ||
      screenshot.browser?.launchNumber !== launchNumber ||
      screenshot.browser?.receiptName !== expectedReceiptName ||
      !/^[0-9a-f]{64}$/u.test(screenshot.browser?.receiptSha256 ?? "") ||
      screenshot.browser?.screenshotName !== screenshot.name ||
      screenshot.browser?.screenshotSha256 !== screenshot.sha256
    ) {
      throw new Error(`${screenshot.name} is not bound to its exact headless-browser receipt.`);
    }
  }
  if (selected[0].browser.browserSession === selected[1].browser.browserSession) {
    throw new Error("Each launch must use a fresh headless-browser session.");
  }
  return selected;
}

function assertScreenshotEvidenceUnchanged(expected, actual) {
  const scalarKeys = ["name", "sha256", "height", "size", "width"];
  if (
    !expected ||
    !actual ||
    scalarKeys.some((key) => expected[key] !== actual[key]) ||
    JSON.stringify(expected.fileIdentity) !== JSON.stringify(actual.fileIdentity) ||
    JSON.stringify(expected.browser) !== JSON.stringify(actual.browser)
  ) {
    throw new Error(`Screenshot ${expected?.name ?? "evidence"} changed after its launch-time validation.`);
  }
  return expected;
}

function validateBrowserReceipt(receipt, expected) {
  const exactKeys = [
    "browserSession",
    "captureTool",
    "challenge",
    "launchNumber",
    "mode",
    "observedAt",
    "schemaVersion",
    "screenshotName",
    "screenshotSha256",
    "title",
    "url",
  ];
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(exactKeys)
  ) {
    throw new Error("Browser receipt must contain only the exact evidence schema fields.");
  }
  if (
    receipt.schemaVersion !== 1 ||
    receipt.captureTool !== "agent-browser" ||
    receipt.mode !== "headless" ||
    receipt.launchNumber !== expected.launchNumber ||
    receipt.challenge !== expected.challenge ||
    receipt.url !== expected.url ||
    receipt.title !== expected.title ||
    receipt.screenshotName !== expected.screenshotName ||
    receipt.screenshotSha256 !== expected.screenshotSha256
  ) {
    throw new Error("Browser receipt does not match the live launch, page, or screenshot.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(receipt.browserSession)) {
    throw new Error("Browser receipt must name one bounded headless-browser session.");
  }
  const observedAtMs = Date.parse(receipt.observedAt);
  if (!Number.isFinite(observedAtMs) || new Date(observedAtMs).toISOString() !== receipt.observedAt) {
    throw new Error("Browser receipt observedAt must be an exact ISO timestamp.");
  }
  if (
    Number.isFinite(expected.earliestObservedAtMs) &&
    observedAtMs < expected.earliestObservedAtMs
  ) {
    throw new Error("Browser receipt predates its managed app launch.");
  }
  if (
    Number.isFinite(expected.latestObservedAtMs) &&
    observedAtMs > expected.latestObservedAtMs
  ) {
    throw new Error("Browser receipt was not observed by the live-launch validation point.");
  }
  return receipt;
}

function interruptionError(signalName) {
  const error = new Error(`Managed restart acceptance interrupted by ${signalName}.`);
  error.name = "AbortError";
  error.signal = signalName;
  return error;
}

function installInterruptHandlers(target = process) {
  if (typeof target?.on !== "function" || typeof target?.off !== "function") {
    throw new Error("Interrupt target must support on/off signal listeners.");
  }
  const controller = new AbortController();
  const interrupt = (signalName) => {
    if (!controller.signal.aborted) controller.abort(interruptionError(signalName));
  };
  const handlers = {
    SIGINT: () => interrupt("SIGINT"),
    SIGTERM: () => interrupt("SIGTERM"),
  };
  for (const [signalName, handler] of Object.entries(handlers)) target.on(signalName, handler);
  return {
    dispose() {
      for (const [signalName, handler] of Object.entries(handlers)) target.off(signalName, handler);
    },
    interrupt,
    signal: controller.signal,
    throwIfAborted() {
      if (controller.signal.aborted) throw controller.signal.reason;
    },
  };
}

async function waitForInteractiveConfirmation(interface, prompt, interrupts) {
  if (
    typeof interface?.question !== "function" ||
    typeof interface?.close !== "function" ||
    typeof interface?.once !== "function" ||
    typeof interface?.off !== "function" ||
    typeof interrupts?.interrupt !== "function" ||
    !interrupts?.signal
  ) {
    throw new Error("Interactive confirmation requires a readline interface and interrupt controller.");
  }
  const onReadlineInterrupt = () => interrupts.interrupt("SIGINT");
  interface.once("SIGINT", onReadlineInterrupt);
  try {
    throwIfAborted(interrupts.signal);
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        interrupts.signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(abortReason(interrupts.signal));
      interrupts.signal.addEventListener("abort", onAbort, { once: true });
      if (interrupts.signal.aborted) {
        onAbort();
        return;
      }
      try {
        interface.question(prompt, () => finish());
      } catch (error) {
        finish(error);
      }
    });
  } finally {
    interface.off("SIGINT", onReadlineInterrupt);
    interface.close();
  }
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
  assertScreenshotEvidenceUnchanged,
  assertTcpPort,
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
  throwIfAborted,
  validateBrowserReceipt,
  waitForInteractiveConfirmation,
  waitForCondition,
};
