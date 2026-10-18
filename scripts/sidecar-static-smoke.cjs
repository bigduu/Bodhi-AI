// Check the real full Bamboo executable against Bodhi's external frontend.
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inventory } = require("./lotus-dist.cjs");
const { sha256 } = require("./bamboo-sidecar.cjs");
const {
  allocateLoopbackPort, isolatedChildEnvironment, observeChildProcessErrors,
  terminateOwnedChild, waitForCondition,
} = require("./managed-restart-contract.cjs");

async function smokeStaticOverride({ binary, version, staticDirectory, signal, launch = spawn,
  readVersion = (file, options) => execFileSync(file, ["--version"], options), timeoutMs = 30000 }) {
  assert.match(version, /^[1-9][0-9]*\.[0-9]+\.[0-9]+$/);
  const files = inventory(staticDirectory);
  const asset = Object.keys(files).find((name) => /^assets\/.+\.(?:js|css)$/.test(name));
  assert.ok(files["index.html"] && asset, "Static smoke needs Bodhi's verified production index and assets");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-full-bamboo-http-"));
  const data = path.join(directory, "data");
  const workspace = path.join(directory, "workspace");
  const external = path.join(directory, "frontend");
  for (const name of ["data", "workspace", "user", "cache", "config"]) fs.mkdirSync(path.join(directory, name));
  let child;
  let teardown;
  try {
    fs.cpSync(staticDirectory, external, { recursive: true });
    assert.deepEqual(inventory(external), files, "Copied frontend changed before the native smoke");
    const challengeName = `bodhi-external-${randomUUID()}.txt`;
    const challenge = `external-static-dir:${randomUUID()}`;
    fs.writeFileSync(path.join(external, challengeName), challenge);
    fs.writeFileSync(path.join(data, "config.json"), "{}\n");
    const environment = isolatedChildEnvironment(process.env, {
      BAMBOO_DATA_DIR: data,
      BAMBOO_JIANDU_DATA_DIR: path.join(directory, "jiandu"),
      CFFIXED_USER_HOME: path.join(directory, "user"),
      USERPROFILE: path.join(directory, "user"),
      XDG_CACHE_HOME: path.join(directory, "cache"),
      XDG_CONFIG_HOME: path.join(directory, "config"),
      XDG_DATA_HOME: data,
      RUST_LOG: "warn,bamboo_server::server::entrypoints=info",
    });
    const actualVersion = readVersion(binary, { cwd: workspace, env: environment, encoding: "utf8", timeout: 10000, maxBuffer: 65536 }).trim();
    assert.equal(actualVersion, `bamboo ${version}`, "Bamboo CLI version differs from the accepted release");
    const port = await allocateLoopbackPort({ signal });
    child = launch(binary, ["serve", "--parent-pid", String(process.pid), "--bind", "127.0.0.1",
      "--port", String(port), "--data-dir", data, "--static-dir", external], {
      cwd: workspace, env: environment, stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new AbortController();
    child.once("exit", () => exited.abort(new Error("Full Bamboo HTTP child exited during the static smoke")));
    const errors = observeChildProcessErrors(child, "Full Bamboo HTTP child", signal);
    const liveSignal = AbortSignal.any([errors.signal, exited.signal]);
    const startupLine = `Unified server running on http://127.0.0.1:${port}`;
    let output = "";
    let bound = false;
    const capture = (chunk) => {
      output = (output + chunk.toString("utf8")).slice(-65536);
      bound ||= output.split(/\r?\n/).slice(0, -1).some((line) => {
        const offset = line.indexOf(startupLine);
        return offset >= 0 && line.slice(offset + startupLine.length).replace(/\x1b\[[0-9;]*m/g, "").trim() === "";
      });
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    await waitForCondition(() => bound, { signal: liveSignal, timeoutMs, label: "Owned Bamboo HTTP bind signal" });
    const request = async (route) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        redirect: "error", signal: AbortSignal.any([liveSignal, AbortSignal.timeout(3000)]),
      });
      assert.equal(response.status, 200, `Full Bamboo HTTP ${route} failed`);
      return Buffer.from(await response.arrayBuffer());
    };
    const health = JSON.parse(await request("/healthz"));
    assert.equal(health.status, "ok");
    assert.equal(health.version, version, "Bamboo server version differs from the accepted release");
    assert.equal((await request("/api/v1/health")).toString(), "OK", "Bodhi's health API changed");
    assert.equal(sha256(await request("/")), files["index.html"], "Embedded frontend replaced Bodhi's index");
    assert.equal(sha256(await request(`/bodhi-static-smoke/${randomUUID()}`)), files["index.html"], "Bodhi SPA fallback changed");
    assert.equal(sha256(await request(`/${asset}`)), files[asset], "Bodhi frontend asset changed");
    assert.equal((await request(`/${challengeName}`)).toString(), challenge, "Explicit --static-dir did not override the embedded frontend");
    return { version, mode: "embedded", embeddedFrontend: true, cliVersion: actualVersion,
      httpVersion: health.version, frontendIndexSha256: files["index.html"], asset,
      externalDirectoryOverride: true, spaFallback: true, legacyHealthApi: true,
      providerCredentials: false };
  } finally {
    if (child?.pid) teardown = await terminateOwnedChild(child);
    if (!child || teardown) fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { smokeStaticOverride };
