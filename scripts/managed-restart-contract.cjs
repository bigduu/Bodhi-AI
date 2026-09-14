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
  isolatedChildEnvironment,
  managedSidecarTeardownComplete,
  pngEvidenceMetadata,
  redactText,
  terminateOwnedChild,
  terminateVerifiedProcess,
  validateBrowserReceipt,
  waitForCondition,
};
