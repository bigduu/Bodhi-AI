#!/usr/bin/env node
// Build the target-specific browser host alongside Bodhi's exact-target Bamboo sidecar.
// The installed app never downloads Node, Playwright, or Chromium at runtime.
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = path.join(__dirname, "browser-runtime.lock.json");
const LOCK = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const STAGED = path.join(ROOT, "src-tauri", "browser-runtime");
const CACHE = path.join(ROOT, "src-tauri", ".browser-runtime-cache");
const LINUX_ARM64 = "aarch64-unknown-linux-gnu";
const WINDOWS_ARM64 = "aarch64-pc-windows-msvc";

function signingIdentity() {
  if (process.env.APPLE_SIGNING_IDENTITY !== undefined) return process.env.APPLE_SIGNING_IDENTITY || null;
  if (process.env.BODHI_BROWSER_RUNTIME_RELEASE_BUILD !== "1") return null;
  const tauri = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
  return tauri.bundle?.macOS?.signingIdentity || null;
}

function targetDetails(target, lock = LOCK) {
  if (lock?.schemaVersion !== 1 || !lock.targets || ["nodeVersion", "playwrightCoreVersion", "chromiumVersion", "chromiumRevision"]
    .some(key => typeof lock[key] !== "string" || !lock[key])) throw new Error("Unsupported browser runtime lock data.");
  if (typeof target !== "string" || !/^[a-z0-9_-]+$/.test(target) || !Object.hasOwn(lock.targets, target)) {
    throw new Error(`Unsupported browser target: ${target}`);
  }
  const details = lock.targets[target];
  if (!details || !/^[a-f0-9]{64}$/.test(details.nodeSha256) || !/^[a-f0-9]{64}$/.test(details.browserSha256)) {
    throw new Error(`Browser downloads for ${target} need pinned SHA-256 values.`);
  }
  if (typeof details.platform !== "string" || !/^[a-z0-9_-]+$/.test(details.platform)) throw new Error("Invalid browser platform directory.");
  if (typeof details.nodePlatform !== "string" || !/^[a-z0-9_-]+$/.test(details.nodePlatform)) {
    throw new Error("Invalid Node platform directory.");
  }
  if (details.browserSource !== undefined && (details.browserSource !== "playwright" ||
      target !== LINUX_ARM64 || details.platform !== "linux-arm64" || !/^\d+$/.test(lock.chromiumRevision))) {
    throw new Error(`Unsupported browser download source for ${target}.`);
  }
  if (details.browserTarget !== undefined && (target !== WINDOWS_ARM64 ||
      details.browserTarget !== "x86_64-pc-windows-msvc" || details.platform !== "win64")) {
    throw new Error(`Unsupported browser architecture override for ${target}.`);
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
  if (!stat.isFile() || stat.isSymbolicLink() || (executable && process.platform !== "win32" && !(stat.mode & 0o111))) {
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
  files.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
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

function browserPaths(runtime, target, lock = LOCK) {
  const { platform } = targetDetails(target, lock);
  return {
    node: path.join(runtime, "node", target.includes("windows") ? "node.exe" : "node"),
    host: path.join(runtime, "host.cjs"),
    browser: path.join(runtime, "chromium", `chrome-headless-shell-${platform}`, target.includes("windows") ? "chrome-headless-shell.exe" : "chrome-headless-shell"),
  };
}

function browserArchive(details, lock) {
  if (details.browserSource === "playwright") {
    const name = "chromium-headless-shell-linux-arm64.zip";
    return {
      cacheName: `playwright-${lock.chromiumRevision}-${name}`,
      url: `https://cdn.playwright.dev/builds/chromium/${lock.chromiumRevision}/${name}`,
    };
  }
  const name = `chrome-headless-shell-${details.platform}.zip`;
  return { cacheName: name, url: `https://edgedl.me.gvt1.com/edgedl/chrome/chrome-for-testing/${lock.chromiumVersion}/${details.platform}/${name}` };
}

function archiveIdentity(target, details) {
  // Historical receipts predate archive digests. Preserve their verification.
  if (target !== LINUX_ARM64 && target !== WINDOWS_ARM64) return {};
  return { nodeArchiveSha256: details.nodeSha256, browserArchiveSha256: details.browserSha256 };
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
  const { expectedArchitecture, elfCpuType, peCpuType } = require("./verify-assembly.cjs");
  const expected = expectedArchitecture(target);
  let matches;
  if (target.includes("darwin")) {
    matches = machCpuTypes(file).includes(expected.mach);
  } else {
    const descriptor = fs.openSync(file, "r");
    try {
      matches = target.includes("windows")
        ? peCpuType(descriptor, file, fs.statSync(file).size) === expected.pe
        : elfCpuType(descriptor, file) === expected.elf;
    } finally { fs.closeSync(descriptor); }
  }
  if (!matches) throw new Error(`${file} does not contain the ${target} CPU architecture.`);
}

function verifyRuntime(runtime, target, source = null, lock = LOCK) {
  const details = targetDetails(target, lock);
  const runtimeStat = fs.lstatSync(runtime);
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
    throw new Error(`Browser runtime root is not an owned directory: ${runtime}`);
  }
  const { node, host, browser } = browserPaths(runtime, target, lock);
  regularFile(node, true);
  regularFile(path.join(runtime, "node", "LICENSE"));
  regularFile(host);
  regularFile(browser, true);
  regularFile(path.join(runtime, "node_modules", "playwright-core", "package.json"));
  verifyArchitecture(node, target);
  verifyArchitecture(browser, details.browserTarget ?? target);
  const pkg = JSON.parse(fs.readFileSync(path.join(runtime, "node_modules", "playwright-core", "package.json"), "utf8"));
  const browsers = JSON.parse(fs.readFileSync(path.join(runtime, "node_modules", "playwright-core", "browsers.json"), "utf8"));
  const shell = browsers.browsers.find((item) => item.name === "chromium-headless-shell");
  if (pkg.version !== lock.playwrightCoreVersion || shell?.revision !== lock.chromiumRevision || shell?.browserVersion !== lock.chromiumVersion) {
    throw new Error("Staged Playwright or Chromium does not match browser-runtime.lock.json.");
  }
  const receipt = JSON.parse(fs.readFileSync(path.join(runtime, "receipt.json"), "utf8"));
  if (receipt.schemaVersion !== 1 || receipt.target !== target || receipt.nodeVersion !== lock.nodeVersion ||
      receipt.playwrightCoreVersion !== lock.playwrightCoreVersion || receipt.chromiumVersion !== lock.chromiumVersion ||
      receipt.chromiumRevision !== lock.chromiumRevision || receipt.filesSha256 !== treeHash(runtime)) {
    throw new Error("Browser runtime receipt or file inventory does not match this target.");
  }
  for (const [key, hash] of Object.entries(archiveIdentity(target, details))) {
    if (receipt[key] !== hash) throw new Error("Browser runtime receipt does not match the locked archives.");
  }
  if (source && (receipt.hostSha256 !== sha256File(path.join(source, "host.cjs")) ||
      receipt.packageLockSha256 !== sha256File(path.join(source, "package-lock.json")))) {
    throw new Error("Bamboo browser host changed after this runtime was staged.");
  }
  for (const executable of target.includes("darwin") ? machFiles(runtime) : []) {
    verifyArchitecture(executable, target);
    if (process.platform === "darwin") {
      execFileSync("codesign", ["--verify", "--strict", executable], { stdio: "pipe" });
    }
  }
  return { ...receipt, node, host, browser };
}

function download(file, url, sha256) {
  fs.mkdirSync(CACHE, { recursive: true });
  if (!fs.existsSync(file)) {
    const temporary = `${file}.${process.pid}.part`;
    try {
      execFileSync("curl", ["-fLsS", "--retry", "2", "--speed-limit", "10000", "--speed-time", "45", "-o", temporary, url], { stdio: "inherit" });
      const downloadedSha256 = sha256File(temporary);
      if (downloadedSha256 !== sha256) {
        throw new Error(`Downloaded archive checksum mismatch: ${url} (expected ${sha256}, got ${downloadedSha256})`);
      }
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

function extractZip(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  if (process.platform === "win32") {
    execFileSync("tar", ["-xf", archive, "-C", destination], { stdio: "inherit" });
  } else {
    execFileSync("unzip", ["-q", archive, "-d", destination], { stdio: "inherit" });
  }
}

function extractBrowser(archive, destination, browser, details) {
  extractZip(archive, destination);
  if (details.browserSource === "playwright") {
    // The Playwright ARM64 archive uses chrome-linux/headless_shell.
    const extracted = path.join(destination, "chrome-linux");
    fs.renameSync(extracted, path.dirname(browser));
    fs.renameSync(path.join(path.dirname(browser), "headless_shell"), browser);
  }
  // Windows ZIP members may lack Unix mode bits when staged on another OS.
  regularFile(browser);
  if (browser.endsWith(".exe")) fs.chmodSync(browser, 0o755);
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
  const identity = target.includes("darwin") ? signingIdentity() : null;
  if (fs.existsSync(STAGED)) {
    try {
      const result = verifyRuntime(STAGED, target, source);
      if (result.signingIdentity !== identity) {
        throw new Error("the signing identity differs from this build");
      }
      console.log(`Verified existing ${target} browser runtime at ${STAGED}`);
      return result;
    } catch (error) {
      const metadata = fs.lstatSync(STAGED);
      const receipt = path.join(STAGED, "receipt.json");
      const inert = path.join(STAGED, "unassembled.txt");
      // Replace only our generated staging tree, never a link or unknown directory.
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw error;
      if (fs.existsSync(receipt)) {
        regularFile(receipt);
        const owned = JSON.parse(fs.readFileSync(receipt, "utf8"));
        if (owned.schemaVersion !== 1 || typeof owned.filesSha256 !== "string" ||
            !LOCK.targets[owned.target]) throw error;
      } else if (!fs.existsSync(inert) ||
          fs.readFileSync(inert, "utf8") !== "Run npm run tauri:dev or npm run tauri:build.\n") throw error;
      console.log(`Refreshing generated browser runtime: ${error.message}`);
    }
  }
  const nodeFolder = `node-v${LOCK.nodeVersion}-${details.nodePlatform}`;
  const nodeArchiveName = `${nodeFolder}.${target.includes("windows") ? "zip" : "tar.gz"}`;
  const browserDownload = browserArchive(details, LOCK);
  const nodeArchive = path.join(CACHE, nodeArchiveName);
  const browserArchiveFile = path.join(CACHE, browserDownload.cacheName);
  download(nodeArchive, `https://nodejs.org/dist/v${LOCK.nodeVersion}/${nodeArchiveName}`, details.nodeSha256);
  download(browserArchiveFile, browserDownload.url, details.browserSha256);

  fs.mkdirSync(path.dirname(STAGED), { recursive: true });
  const scratch = fs.mkdtempSync(path.join(path.dirname(STAGED), ".browser-runtime-stage-"));
  const runtime = path.join(scratch, "runtime");
  fs.mkdirSync(runtime);
  try {
    const { node, browser } = browserPaths(runtime, target);
    if (target.includes("windows")) extractZip(nodeArchive, scratch);
    else execFileSync("tar", ["-xzf", nodeArchive, "-C", scratch], { stdio: "inherit" });
    const nodeSource = target.includes("windows")
      ? path.join(scratch, nodeFolder, "node.exe")
      : path.join(scratch, nodeFolder, "bin", "node");
    fs.mkdirSync(path.join(runtime, "node"));
    fs.copyFileSync(nodeSource, node);
    const nodeLicense = path.join(scratch, nodeFolder, "LICENSE");
    regularFile(nodeLicense);
    fs.copyFileSync(nodeLicense, path.join(runtime, "node", "LICENSE"));
    fs.chmodSync(node, 0o755);
    extractBrowser(browserArchiveFile, path.join(runtime, "chromium"), browser, details);
    for (const name of ["host.cjs", "package.json", "package-lock.json"]) {
      fs.copyFileSync(path.join(source, name), path.join(runtime, name));
    }
    execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-bin-links", "--no-audit", "--no-fund"], { cwd: runtime, stdio: "inherit", shell: process.platform === "win32" });
    // playwright-core publishes executable reinstall helpers for browsers and
    // platforms we never run. macOS deep signing treats those scripts as nested
    // code, so keep only the runtime library and make its data files non-exec.
    const playwright = path.join(runtime, "node_modules", "playwright-core");
    fs.rmSync(path.join(playwright, "bin"), { recursive: true });
    fs.rmSync(path.join(playwright, "lib", "xdg-open"));
    fs.chmodSync(path.join(playwright, "cli.js"), 0o644);
    fs.chmodSync(path.join(playwright, "lib", "webp_codec.wasm"), 0o644);
    verifyArchitecture(node, target);
    verifyArchitecture(browser, details.browserTarget ?? target);
    const hostPlatform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win" : "linux";
    if (details.nodePlatform === `${hostPlatform}-${process.arch}`) {
      const actual = execFileSync(node, ["--version"], { encoding: "utf8" }).trim();
      if (actual !== `v${LOCK.nodeVersion}`) throw new Error(`Wrong staged Node version: ${actual}`);
    }
    if (target.includes("darwin")) signNested(runtime);
    const receipt = {
      schemaVersion: 1,
      target,
      nodeVersion: LOCK.nodeVersion,
      playwrightCoreVersion: LOCK.playwrightCoreVersion,
      chromiumVersion: LOCK.chromiumVersion,
      chromiumRevision: LOCK.chromiumRevision,
      ...archiveIdentity(target, details),
      signingIdentity: identity,
      hostSha256: sha256File(path.join(source, "host.cjs")),
      packageLockSha256: sha256File(path.join(source, "package-lock.json")),
      filesSha256: treeHash(runtime),
    };
    fs.writeFileSync(path.join(runtime, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    verifyRuntime(runtime, target, source);
    const previous = path.join(scratch, "previous");
    if (fs.existsSync(STAGED)) fs.renameSync(STAGED, previous);
    try { fs.renameSync(runtime, STAGED); }
    catch (error) {
      if (fs.existsSync(previous)) fs.renameSync(previous, STAGED);
      throw error;
    }
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
    const bambooSource = process.env.BAMBOO_SIDECAR_SOURCE === "release"
      ? require("./bamboo-sidecar.cjs").installedRelease(ROOT, target).hostDirectory
      : path.resolve(ROOT, process.env.BAMBOO_LOCAL_PATH || "../bamboo");
    stageRuntime(target, bambooSource);
  } catch (error) {
    console.error(`Browser runtime: ${error.message}`);
    process.exitCode = 1;
  }
}
