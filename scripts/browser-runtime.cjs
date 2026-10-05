#!/usr/bin/env node
// Build the macOS browser host alongside Bodhi's exact-target Bamboo sidecar.
// The installed app never downloads Node, Playwright, or Chromium at runtime.
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = path.join(__dirname, "browser-runtime.lock.json");
const LOCK = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const STAGED = path.join(ROOT, "src-tauri", "browser-runtime");
const CACHE = path.join(ROOT, "src-tauri", ".browser-runtime-cache");

function signingIdentity() {
  if (process.env.APPLE_SIGNING_IDENTITY !== undefined) return process.env.APPLE_SIGNING_IDENTITY || null;
  if (process.env.BODHI_BROWSER_RUNTIME_RELEASE_BUILD !== "1") return null;
  const tauri = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
  return tauri.bundle?.macOS?.signingIdentity || null;
}

function targetDetails(target) {
  const details = LOCK.targets[target];
  if (!details || !/^[a-z0-9_-]+$/.test(target)) {
    throw new Error(`Unsupported macOS browser target: ${target}`);
  }
  if (!/^[a-f0-9]{64}$/.test(details.nodeSha256) || !/^[a-f0-9]{64}$/.test(details.browserSha256)) {
    throw new Error(`Browser downloads for ${target} need pinned SHA-256 values.`);
  }
  return details;
}

function sha256File(file) {
  const digest = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const length = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!length) break;
      digest.update(buffer.subarray(0, length));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest("hex");
}

function regularFile(file, executable = false) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (executable && !(stat.mode & 0o111))) {
    throw new Error(`Expected a regular${executable ? " executable" : ""} file: ${file}`);
  }
  return stat;
}

function fileInventory(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Browser runtime contains a symlink: ${file}`);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && file !== path.join(root, "receipt.json")) {
        files.push([path.relative(root, file).split(path.sep).join("/"), sha256File(file)]);
      } else if (!entry.isFile()) throw new Error(`Invalid browser runtime entry: ${file}`);
    }
  }
  visit(root);
  files.sort(([a], [b]) => a.localeCompare(b));
  return files;
}

function machFiles(root) {
  const magic = new Set(["cffaedfe", "feedfacf", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);
  return fileInventory(root).map(([name]) => path.join(root, name)).filter((file) => {
    const header = Buffer.alloc(4);
    const descriptor = fs.openSync(file, "r");
    try { fs.readSync(descriptor, header, 0, 4, 0); } finally { fs.closeSync(descriptor); }
    return magic.has(header.toString("hex"));
  });
}

function treeHash(root) {
  const digest = crypto.createHash("sha256");
  for (const [name, hash] of fileInventory(root)) digest.update(`${name}\0${hash}\n`);
  return digest.digest("hex");
}

function browserPaths(runtime, target) {
  const { platform } = targetDetails(target);
  return {
    node: path.join(runtime, "node", "node"),
    host: path.join(runtime, "host.cjs"),
    browser: path.join(runtime, "chromium", `chrome-headless-shell-${platform}`, "chrome-headless-shell"),
  };
}

function machCpuTypes(file) {
  const descriptor = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(8);
    if (fs.readSync(descriptor, header, 0, 8, 0) !== 8) throw new Error(`Short Mach-O header: ${file}`);
    const magic = header.subarray(0, 4).toString("hex");
    if (magic === "cffaedfe") return [header.readUInt32LE(4)];
    if (magic === "feedfacf") return [header.readUInt32BE(4)];
    const formats = {
      cafebabe: { little: false, size: 20 },
      bebafeca: { little: true, size: 20 },
      cafebabf: { little: false, size: 32 },
      bfbafeca: { little: true, size: 32 },
    };
    const format = formats[magic];
    if (!format) throw new Error(`Expected a Mach-O executable: ${file}`);
    const read = (buffer, offset) => format.little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    const count = read(header, 4);
    if (!count || count > 64) throw new Error(`Invalid Mach-O architecture table: ${file}`);
    const types = [];
    for (let index = 0; index < count; index += 1) {
      const entry = Buffer.alloc(format.size);
      if (fs.readSync(descriptor, entry, 0, entry.length, 8 + index * entry.length) !== entry.length) {
        throw new Error(`Short Mach-O architecture table: ${file}`);
      }
      types.push(read(entry, 0));
    }
    return types;
  } finally {
    fs.closeSync(descriptor);
  }
}

function verifyArchitecture(file, target) {
  const expected = target === "aarch64-apple-darwin" ? 0x0100000c : 0x01000007;
  if (!machCpuTypes(file).includes(expected)) {
    throw new Error(`${file} does not contain the ${target} CPU architecture.`);
  }
}

function verifyRuntime(runtime, target, source = null) {
  targetDetails(target);
  const runtimeStat = fs.lstatSync(runtime);
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
    throw new Error(`Browser runtime root is not an owned directory: ${runtime}`);
  }
  const { node, host, browser } = browserPaths(runtime, target);
  regularFile(node, true);
  regularFile(host);
  regularFile(browser, true);
  regularFile(path.join(runtime, "node_modules", "playwright-core", "package.json"));
  verifyArchitecture(node, target);
  verifyArchitecture(browser, target);
  const pkg = JSON.parse(fs.readFileSync(path.join(runtime, "node_modules", "playwright-core", "package.json"), "utf8"));
  const browsers = JSON.parse(fs.readFileSync(path.join(runtime, "node_modules", "playwright-core", "browsers.json"), "utf8"));
  const shell = browsers.browsers.find((item) => item.name === "chromium-headless-shell");
  if (pkg.version !== LOCK.playwrightCoreVersion || shell?.revision !== LOCK.chromiumRevision || shell?.browserVersion !== LOCK.chromiumVersion) {
    throw new Error("Staged Playwright or Chromium does not match browser-runtime.lock.json.");
  }
  const receipt = JSON.parse(fs.readFileSync(path.join(runtime, "receipt.json"), "utf8"));
  if (receipt.schemaVersion !== 1 || receipt.target !== target || receipt.nodeVersion !== LOCK.nodeVersion ||
      receipt.playwrightCoreVersion !== LOCK.playwrightCoreVersion || receipt.chromiumVersion !== LOCK.chromiumVersion ||
      receipt.chromiumRevision !== LOCK.chromiumRevision || receipt.filesSha256 !== treeHash(runtime)) {
    throw new Error("Browser runtime receipt or file inventory does not match this target.");
  }
  if (source && (receipt.hostSha256 !== sha256File(path.join(source, "host.cjs")) ||
      receipt.packageLockSha256 !== sha256File(path.join(source, "package-lock.json")))) {
    throw new Error("Bamboo browser host changed after this runtime was staged.");
  }
  for (const executable of machFiles(runtime)) {
    verifyArchitecture(executable, target);
    if (process.platform === "darwin") {
      execFileSync("codesign", ["--verify", "--strict", executable], { stdio: "pipe" });
    }
  }
  return { ...receipt, ...browserPaths(runtime, target) };
}

function download(file, url, sha256) {
  fs.mkdirSync(CACHE, { recursive: true });
  if (!fs.existsSync(file)) {
    const temporary = `${file}.${process.pid}.part`;
    try {
      execFileSync("curl", ["-fLsS", "--retry", "2", "--speed-limit", "10000", "--speed-time", "45", "-o", temporary, url], { stdio: "inherit" });
      if (sha256File(temporary) !== sha256) throw new Error(`Downloaded archive checksum mismatch: ${url}`);
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary);
    }
  }
  if (sha256File(file) !== sha256) throw new Error(`Cached browser archive checksum mismatch: ${file}`);
}

function signNested(runtime) {
  const identity = signingIdentity();
  if (process.platform !== "darwin" || !identity) return;
  for (const file of machFiles(runtime)) {
    const args = ["--force", "--sign", identity];
    if (identity !== "-") {
      args.push("--options", "runtime", "--timestamp");
      if (path.basename(file) === "node" || path.basename(file) === "chrome-headless-shell") {
        args.push("--entitlements", path.join(ROOT, "src-tauri", "browser-runtime-entitlements.plist"));
      }
    }
    args.push(file);
    execFileSync("codesign", args, { stdio: "inherit" });
  }
}

function stageRuntime(target, bambooSource) {
  const details = targetDetails(target);
  const source = path.join(bambooSource, "browser-runtime");
  for (const name of ["host.cjs", "package.json", "package-lock.json"]) regularFile(path.join(source, name));
  const packageLock = JSON.parse(fs.readFileSync(path.join(source, "package-lock.json"), "utf8"));
  const lockedPackage = packageLock.packages?.["node_modules/playwright-core"];
  if (lockedPackage?.version !== LOCK.playwrightCoreVersion || lockedPackage?.integrity !== LOCK.playwrightCoreIntegrity) {
    throw new Error("Bamboo playwright-core package lock differs from Bodhi's browser runtime lock.");
  }
  if (fs.existsSync(STAGED)) {
    try {
      const result = verifyRuntime(STAGED, target, source);
      if (result.signingIdentity !== signingIdentity()) {
        throw new Error("the signing identity differs from this build");
      }
      console.log(`Verified existing ${target} browser runtime at ${STAGED}`);
      return result;
    } catch (error) {
      throw new Error(`Existing browser runtime was left untouched (${error.message}). Stop any Bodhi instance using it, verify that ${STAGED} is generated and inactive, then remove it and rebuild.`);
    }
  }
  const nodeArchiveName = `node-v${LOCK.nodeVersion}-darwin-${details.platform === "mac-arm64" ? "arm64" : "x64"}.tar.gz`;
  const browserArchiveName = `chrome-headless-shell-${details.platform}.zip`;
  const nodeArchive = path.join(CACHE, nodeArchiveName);
  const browserArchive = path.join(CACHE, browserArchiveName);
  download(nodeArchive, `https://nodejs.org/dist/v${LOCK.nodeVersion}/${nodeArchiveName}`, details.nodeSha256);
  download(browserArchive, `https://edgedl.me.gvt1.com/edgedl/chrome/chrome-for-testing/${LOCK.chromiumVersion}/${details.platform}/${browserArchiveName}`, details.browserSha256);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-browser-runtime-"));
  const runtime = path.join(scratch, "runtime");
  fs.mkdirSync(runtime);
  try {
    execFileSync("tar", ["-xzf", nodeArchive, "-C", scratch], { stdio: "inherit" });
    const nodeSource = path.join(scratch, `node-v${LOCK.nodeVersion}-darwin-${details.platform === "mac-arm64" ? "arm64" : "x64"}`, "bin", "node");
    fs.mkdirSync(path.join(runtime, "node"));
    fs.copyFileSync(nodeSource, path.join(runtime, "node", "node"));
    fs.chmodSync(path.join(runtime, "node", "node"), 0o755);
    fs.mkdirSync(path.join(runtime, "chromium"));
    execFileSync("unzip", ["-q", browserArchive, "-d", path.join(runtime, "chromium")], { stdio: "inherit" });
    for (const name of ["host.cjs", "package.json", "package-lock.json"]) {
      fs.copyFileSync(path.join(source, name), path.join(runtime, name));
    }
    execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-bin-links", "--no-audit", "--no-fund"], { cwd: runtime, stdio: "inherit" });
    // playwright-core publishes executable reinstall helpers for browsers and
    // platforms we never run. macOS deep signing treats those scripts as nested
    // code, so keep only the runtime library and make its data files non-exec.
    const playwright = path.join(runtime, "node_modules", "playwright-core");
    fs.rmSync(path.join(playwright, "bin"), { recursive: true });
    fs.rmSync(path.join(playwright, "lib", "xdg-open"));
    fs.chmodSync(path.join(playwright, "cli.js"), 0o644);
    fs.chmodSync(path.join(playwright, "lib", "webp_codec.wasm"), 0o644);
    const { node, browser } = browserPaths(runtime, target);
    verifyArchitecture(node, target);
    verifyArchitecture(browser, target);
    if (process.arch === (target === "aarch64-apple-darwin" ? "arm64" : "x64")) {
      const actual = execFileSync(node, ["--version"], { encoding: "utf8" }).trim();
      if (actual !== `v${LOCK.nodeVersion}`) throw new Error(`Wrong staged Node version: ${actual}`);
    }
    signNested(runtime);
    const receipt = {
      schemaVersion: 1,
      target,
      nodeVersion: LOCK.nodeVersion,
      playwrightCoreVersion: LOCK.playwrightCoreVersion,
      chromiumVersion: LOCK.chromiumVersion,
      chromiumRevision: LOCK.chromiumRevision,
      signingIdentity: signingIdentity(),
      hostSha256: sha256File(path.join(source, "host.cjs")),
      packageLockSha256: sha256File(path.join(source, "package-lock.json")),
      filesSha256: treeHash(runtime),
    };
    fs.writeFileSync(path.join(runtime, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    verifyRuntime(runtime, target, source);
    if (fs.existsSync(STAGED)) throw new Error(`Browser runtime appeared while staging: ${STAGED}`);
    fs.renameSync(runtime, STAGED);
    console.log(`Staged ${target} browser runtime at ${STAGED}`);
    return verifyRuntime(STAGED, target, source);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { LOCK, STAGED, browserPaths, machCpuTypes, machFiles, sha256File, signingIdentity, stageRuntime, targetDetails, treeHash, verifyArchitecture, verifyRuntime };

if (require.main === module) {
  try {
    const target = process.argv[2] || process.env.BAMBOO_SIDECAR_TARGET;
    const bambooSource = path.resolve(ROOT, process.env.BAMBOO_LOCAL_PATH || "../bamboo");
    stageRuntime(target, bambooSource);
  } catch (error) {
    console.error(`Browser runtime: ${error.message}`);
    process.exitCode = 1;
  }
}
