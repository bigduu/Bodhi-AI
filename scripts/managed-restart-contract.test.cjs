const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const {
  allocateLoopbackPort,
  assertEvidenceRedacted,
  assertFullRevision,
  assertIdentityMatches,
  assertLoopbackPortAvailable,
  assertOwnedAbsolutePath,
  assertScreenshotEvidenceUnchanged,
  distinctLaunchScreenshots,
  isolatedChildEnvironment,
  managedSidecarTeardownComplete,
  pngEvidenceMetadata,
  redactText,
  terminateOwnedChild,
  terminateVerifiedProcess,
  validateBrowserReceipt,
  waitForCondition,
} = require("./managed-restart-contract.cjs");

const REVISION_A = "a".repeat(40);
const REVISION_B = "b".repeat(40);
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function screenshotPng(width = 320, height = 200, encodedOverride = null) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  let seed = 0x12345678;
  for (let row = 0; row < height; row += 1) {
    const rowStart = row * (width * 3 + 1);
    scanlines[rowStart] = 0;
    for (let index = 1; index <= width * 3; index += 1) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      scanlines[rowStart + index] = seed >>> 24;
    }
  }
  const encoded = encodedOverride ?? zlib.deflateSync(scanlines);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", encoded),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("requires full exact Git revisions and rejects identity drift", () => {
  assert.equal(assertFullRevision(REVISION_A, "Bodhi"), REVISION_A);
  assert.equal(assertIdentityMatches(REVISION_A, REVISION_A, "Bodhi"), REVISION_A);
  assert.throws(() => assertFullRevision("abc", "Bamboo"), /exact 40-character/);
  assert.throws(
    () => assertIdentityMatches(REVISION_A, REVISION_B, "Bamboo"),
    /revision mismatch/,
  );
});

test("all mutable paths must be absolute and run-owned", () => {
  const root = path.join(os.tmpdir(), "bodhi-owned-root");
  assert.equal(
    assertOwnedAbsolutePath(root, path.join(root, "evidence"), "evidence"),
    path.join(root, "evidence"),
  );
  assert.throws(
    () => assertOwnedAbsolutePath(root, path.join(root, "..", "outside"), "data"),
    /inside the run-owned root/,
  );
  assert.throws(
    () => assertOwnedAbsolutePath("relative", "relative/data", "data"),
    /absolute paths/,
  );
});

test("isolated child environments drop host credentials and runtime controls", () => {
  const environment = isolatedChildEnvironment(
    {
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      HOME: "/Users/example",
      BAMBOO_DATA_DIR: "/Users/example/.bamboo",
      BAMBOO_API_KEY: "host-secret",
      GH_TOKEN: "host-token",
      HTTP_PROXY: "http://proxy.invalid",
      NODE_OPTIONS: "--require untrusted.js",
      PYTHONHOME: "/host/python",
      PYTHONPATH: "/host/python/modules",
      SSH_AUTH_SOCK: "/private/tmp/agent.sock",
    },
    {
      HOME: "/private/tmp/synthetic-home",
      BAMBOO_DATA_DIR: "/private/tmp/run/bamboo",
      BODHI_ACCEPTANCE_PROVIDER_KEY: "synthetic-key",
    },
  );

  assert.deepEqual(environment, {
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    HOME: "/private/tmp/synthetic-home",
    BAMBOO_DATA_DIR: "/private/tmp/run/bamboo",
    BODHI_ACCEPTANCE_PROVIDER_KEY: "synthetic-key",
  });
  assert.throws(
    () => isolatedChildEnvironment({}, { HOME: null }),
    /override HOME must be a string/,
  );
});

test("occupied loopback ports are refused without disturbing the owner", async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await assert.rejects(assertLoopbackPortAvailable(address.port), /already occupied/);
  assert.equal(server.listening, true);
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

  const freePort = await allocateLoopbackPort();
  await assertLoopbackPortAvailable(freePort);
});

test("teardown is bounded and targets only the spawned process", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const startedAt = Date.now();
  const result = await terminateOwnedChild(child, { graceMs: 1_000, killMs: 1_000 });
  assert.match(result.phase, /sigterm|sigkill/);
  assert(Date.now() - startedAt < 2_500);
  assert(child.exitCode !== null || child.signalCode !== null);

  await assert.rejects(
    waitForCondition(() => false, { timeoutMs: 60, intervalMs: 10, label: "test fence" }),
    /test fence did not complete within 60ms/,
  );
});

test("verified PID teardown refuses reuse and force-cleans the exact identity", async () => {
  const expected = { pid: 4242, startedAt: "Mon Sep 14 02:00:00 2026", command: "bamboo" };
  let actual = { ...expected };
  const signals = [];
  const result = await terminateVerifiedProcess(expected, {
    inspect: () => actual,
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") actual = null;
    },
    graceMs: 20,
    killMs: 20,
    intervalMs: 2,
  });
  assert.deepEqual(result, { phase: "sigkill", pid: expected.pid });
  assert.deepEqual(signals, [
    [expected.pid, "SIGTERM"],
    [expected.pid, "SIGKILL"],
  ]);

  actual = { ...expected, startedAt: "Mon Sep 14 02:00:01 2026" };
  await assert.rejects(
    terminateVerifiedProcess(expected, { inspect: () => actual, signal: () => signals.push("unsafe") }),
    /identity changed/,
  );
  assert.equal(signals.includes("unsafe"), false);
});

test("sidecar teardown never succeeds while its identity is unknown", () => {
  const expected = { pid: 4242, startedAt: "Mon Sep 14 02:00:00 2026", command: "/owned/bamboo" };
  assert.equal(managedSidecarTeardownComplete(null, null, []), false);
  assert.equal(managedSidecarTeardownComplete(expected, expected, []), false);
  assert.equal(managedSidecarTeardownComplete(expected, null, [4242]), false);
  assert.equal(managedSidecarTeardownComplete(expected, null, []), true);
  assert.throws(
    () => managedSidecarTeardownComplete(expected, { ...expected, startedAt: "changed" }, []),
    /identity changed/,
  );
});

test("PNG evidence requires CRC-valid decodable screenshot pixels", () => {
  const bytes = screenshotPng();
  assert(bytes.length > 1_024);
  assert.deepEqual(pngEvidenceMetadata(bytes), { height: 200, size: bytes.length, width: 320 });
  assert.throws(() => pngEvidenceMetadata(Buffer.alloc(0)), /valid PNG/);
  const corruptCrc = Buffer.from(bytes);
  corruptCrc[corruptCrc.length - 13] ^= 0xff;
  assert.throws(() => pngEvidenceMetadata(corruptCrc), /invalid CRC/);
  assert.throws(() => pngEvidenceMetadata(screenshotPng(320, 200, Buffer.alloc(1_100, 0x55))), /undecodable/);
  assert.throws(() => pngEvidenceMetadata(screenshotPng(1, 200)), /supported screenshot dimensions/);
});

test("each launch requires an exact screenshot with distinct bytes", () => {
  const first = {
    name: "browser-launch-1.png",
    sha256: "a".repeat(64),
    height: 200,
    size: 1_024,
    width: 320,
    fileIdentity: { device: 1, inode: 10, changeTimeMs: 100, modifiedTimeMs: 100 },
    browser: {
      schemaVersion: 1,
      launchNumber: 1,
      captureTool: "agent-browser",
      mode: "headless",
      browserSession: "acceptance-launch-1",
      screenshotName: "browser-launch-1.png",
      screenshotSha256: "a".repeat(64),
      receiptName: "browser-launch-1.json",
      receiptSha256: "c".repeat(64),
    },
  };
  const second = {
    name: "browser-launch-2.png",
    sha256: "b".repeat(64),
    height: 200,
    size: 1_025,
    width: 320,
    fileIdentity: { device: 1, inode: 11, changeTimeMs: 101, modifiedTimeMs: 101 },
    browser: {
      schemaVersion: 1,
      launchNumber: 2,
      captureTool: "agent-browser",
      mode: "headless",
      browserSession: "acceptance-launch-2",
      screenshotName: "browser-launch-2.png",
      screenshotSha256: "b".repeat(64),
      receiptName: "browser-launch-2.json",
      receiptSha256: "d".repeat(64),
    },
  };
  assert.deepEqual(distinctLaunchScreenshots([second, first]), [first, second]);
  assert.throws(
    () => distinctLaunchScreenshots([{ name: "launch-1-launch-2.png", sha256: "c".repeat(64) }]),
    /separate exact files/,
  );
  assert.throws(
    () => distinctLaunchScreenshots([first, { ...second, sha256: first.sha256 }]),
    /distinct captured bytes/,
  );
  assert.throws(() => distinctLaunchScreenshots([first, second, { ...second, name: "extra.png" }]), /only the two/);
  assert.equal(assertScreenshotEvidenceUnchanged(first, { ...first }), first);
  assert.throws(
    () => assertScreenshotEvidenceUnchanged(first, { ...first, fileIdentity: { ...first.fileIdentity, inode: 99 } }),
    /changed after its launch-time validation/,
  );
  assert.throws(
    () => assertScreenshotEvidenceUnchanged(first, { ...first, sha256: "c".repeat(64) }),
    /changed after its launch-time validation/,
  );
  assert.throws(
    () =>
      assertScreenshotEvidenceUnchanged(first, {
        ...first,
        browser: { ...first.browser, url: "http://127.0.0.1:9999/" },
      }),
    /changed after its launch-time validation/,
  );
  assert.throws(
    () => distinctLaunchScreenshots([first, { ...second, browser: { ...second.browser, browserSession: first.browser.browserSession } }]),
    /fresh headless-browser session/,
  );
});

test("browser receipt binds the live launch URL, title, challenge, session, and screenshot", () => {
  const observedAt = "2026-09-14T04:05:20.225Z";
  const receipt = {
    schemaVersion: 1,
    launchNumber: 1,
    captureTool: "agent-browser",
    mode: "headless",
    browserSession: "bodhi-67-launch-1",
    challenge: "5a62b502-dab3-47c2-aa4c-24b9cf5d19de",
    observedAt,
    url: "http://127.0.0.1:58930/",
    title: "Bodhi",
    screenshotName: "browser-launch-1.png",
    screenshotSha256: "a".repeat(64),
  };
  const expected = {
    challenge: receipt.challenge,
    earliestObservedAtMs: Date.parse(observedAt) - 1,
    latestObservedAtMs: Date.parse(observedAt) + 1,
    launchNumber: 1,
    screenshotName: receipt.screenshotName,
    screenshotSha256: receipt.screenshotSha256,
    title: receipt.title,
    url: receipt.url,
  };
  assert.equal(validateBrowserReceipt(receipt, expected), receipt);
  assert.throws(
    () => validateBrowserReceipt({ ...receipt, url: "http://127.0.0.1:58931/" }, expected),
    /does not match the live launch/,
  );
  assert.throws(
    () => validateBrowserReceipt({ ...receipt, title: "generic page" }, expected),
    /does not match the live launch/,
  );
  assert.throws(
    () => validateBrowserReceipt({ ...receipt, screenshotSha256: "b".repeat(64) }, expected),
    /does not match the live launch/,
  );
  assert.throws(
    () => validateBrowserReceipt({ ...receipt, observedAt: "2026-09-14T04:05:19.000Z" }, expected),
    /predates its managed app launch/,
  );
  assert.throws(
    () => validateBrowserReceipt({ ...receipt, unexpected: true }, expected),
    /exact evidence schema fields/,
  );
});

test("evidence redaction removes every designated secret", () => {
  const secret = "synthetic-secret-for-test";
  const redacted = redactText(`before ${secret} after`, [secret]);
  assert.equal(redacted, "before [REDACTED] after");
  assert.doesNotThrow(() => assertEvidenceRedacted({ redacted }, [secret]));
  assert.throws(
    () => assertEvidenceRedacted({ nested: { value: secret } }, [secret]),
    /designated as secret/,
  );
});
