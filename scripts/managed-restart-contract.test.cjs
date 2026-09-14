const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  allocateLoopbackPort,
  assertEvidenceRedacted,
  assertFullRevision,
  assertIdentityMatches,
  assertLoopbackPortAvailable,
  assertOwnedAbsolutePath,
  isolatedChildEnvironment,
  redactText,
  terminateOwnedChild,
  waitForCondition,
} = require("./managed-restart-contract.cjs");

const REVISION_A = "a".repeat(40);
const REVISION_B = "b".repeat(40);

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
