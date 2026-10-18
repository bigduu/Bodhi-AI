#!/usr/bin/env node
// Consume published Bamboo executables. This module never builds Bamboo source.
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");
const { isDeepStrictEqual } = require("node:util");

const ROOT = path.resolve(__dirname, "..");
const REPOSITORY = "bigduu/Bamboo-agent";
const MANIFEST = "bamboo-sidecars-v1.json";
const HOST_ASSET = "bamboo-browser-host-v1.tar.gz";
const TARGETS = Object.freeze([
  "aarch64-apple-darwin", "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu",
]);
const HOST_FILES = Object.freeze([
  "browser-runtime/host.cjs", "browser-runtime/package-lock.json", "browser-runtime/package.json",
]);
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_MANIFEST = 1024 * 1024;
const MAX_BINARY = 1024 * 1024 * 1024;
const MAX_HOST = 8 * 1024 * 1024;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const binaryName = (target) => `bamboo-${target}${target.includes("windows") ? ".exe" : ""}`;
const exists = (file) => {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
};

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function readRegular(file, maxBytes) {
  const stat = fs.lstatSync(file);
  requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes,
    `Expected a bounded regular file: ${file}`);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor);
    requireCondition(opened.isFile() && opened.dev === stat.dev && opened.ino === stat.ino && opened.size === stat.size,
      `File changed while opening: ${file}`);
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

// All generated paths stay below the caller's checkout; no linked directories
// or linked output files may redirect cache/staging writes elsewhere.
function safeDirectory(root, directory) {
  const relative = path.relative(root, directory);
  requireCondition(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "Generated path escapes the checkout.");
  let current = root;
  for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    if (!exists(current)) fs.mkdirSync(current);
    const stat = fs.lstatSync(current);
    requireCondition(stat.isDirectory() && !stat.isSymbolicLink(), `Expected an owned directory: ${current}`);
  }
  return directory;
}

function validateLock(lock, env = {}) {
  requireCondition(lock?.schemaVersion === 1 && lock.repository === REPOSITORY &&
    lock.manifestAssetName === MANIFEST && lock.buildMode === "embedded" && lock.embeddedFrontend === true,
  "Invalid Bamboo sidecar lock identity or build mode.");
  requireCondition(typeof lock.version === "string" && /^[1-9][0-9]*\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/.test(lock.version) &&
    /^[0-9a-f]{40}$/.test(lock.sourceRevision || "") && SHA256.test(lock.manifestSha256 || ""),
  "Bamboo sidecar release is not accepted: pin the real published version, full sourceRevision and manifestSha256 in scripts/bamboo-sidecar-lock.json. No source-build fallback is permitted.");
  requireCondition(isDeepStrictEqual(lock.targets, TARGETS), "Bamboo sidecar lock must cover the four desktop release targets in sorted order.");
  for (const [key, value] of [["BAMBOO_RELEASE_VERSION", lock.version], ["BAMBOO_RELEASE_SOURCE_REVISION", lock.sourceRevision]]) {
    if (env[key]) requireCondition(env[key] === value, `${key} differs from the accepted Bamboo sidecar lock.`);
  }
  return lock;
}

function readLock(root = ROOT, env = process.env) {
  safeDirectory(root, path.join(root, "scripts"));
  return validateLock(JSON.parse(readRegular(path.join(root, "scripts/bamboo-sidecar-lock.json"), MAX_MANIFEST)), env);
}

function requireDigest(value, maxBytes, label, minimum = 1) {
  requireCondition(value && SHA256.test(value.sha256 || "") && Number.isSafeInteger(value.sizeBytes) &&
    value.sizeBytes >= minimum && value.sizeBytes <= maxBytes, `Invalid ${label} SHA-256 or sizeBytes.`);
}

function validateManifest(bytes, lock, target) {
  requireCondition(TARGETS.includes(target), `Unsupported Bamboo sidecar target: ${target}`);
  requireCondition(bytes.length <= MAX_MANIFEST && sha256(bytes) === lock.manifestSha256, "Bamboo sidecar manifest SHA-256 mismatch.");
  const manifest = JSON.parse(bytes);
  requireCondition(manifest.schemaVersion === 1 && manifest.version === lock.version && manifest.sourceRevision === lock.sourceRevision,
    "Bamboo sidecar manifest version or sourceRevision differs from the lock.");
  requireCondition(Array.isArray(manifest.artifacts) && isDeepStrictEqual(manifest.artifacts.map((item) => item.target), TARGETS),
    "Bamboo sidecar manifest has missing, duplicate, unexpected or unsorted targets.");
  for (const item of manifest.artifacts) {
    requireCondition(item.buildMode === "embedded" && item.embeddedFrontend === true && item.format === "raw" &&
      item.assetName === binaryName(item.target),
    "Bamboo artifact must be the exact raw full executable with its standard embedded frontend.");
    requireDigest(item, MAX_BINARY, "sidecar artifact", 65536);
    if (item.binaryName !== undefined) requireCondition(item.binaryName === item.assetName, "Raw binaryName must equal assetName.");
    if (item.binarySha256 !== undefined) requireCondition(item.binarySha256 === item.sha256, "Raw binarySha256 must equal sha256.");
    if (item.binarySizeBytes !== undefined) requireCondition(item.binarySizeBytes === item.sizeBytes, "Raw binarySizeBytes must equal sizeBytes.");
  }
  const host = manifest.browserHost;
  requireDigest(host, MAX_HOST, "browser host archive");
  requireCondition(host.assetName === HOST_ASSET && Array.isArray(host.files) &&
    isDeepStrictEqual(host.files.map((file) => file.path).sort(), HOST_FILES), "Browser host must contain exactly the three declared files.");
  for (const file of host.files) requireDigest(file, MAX_HOST, "browser host file");
  return { manifest, artifact: manifest.artifacts.find((item) => item.target === target) };
}

function releaseUrl(lock, assetName) {
  requireCondition(assetName === MANIFEST || assetName === HOST_ASSET || TARGETS.some((target) => binaryName(target) === assetName), "Unexpected Bamboo release asset name.");
  return `https://github.com/${REPOSITORY}/releases/download/v${lock.version}/${assetName}`;
}

function downloadAsset(url, file, maxBytes) {
  // -q disables user curl configuration; no token, netrc or authorization header
  // is supplied, including across GitHub's HTTPS asset redirects.
  try {
    execFileSync("curl", ["-q", "--fail", "--silent", "--show-error", "--location",
      "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "15", "--max-time", "300",
      "--max-filesize", String(maxBytes), "--output", file, url], { stdio: ["ignore", "ignore", "pipe"] });
  } catch {
    throw new Error(`Cannot download ${path.basename(file).split(".part-")[0]} from the locked public Bamboo release. Check publication and connectivity; no source-build fallback is permitted.`);
  }
}

function cachedAsset(root, cache, lock, name, digest, sizeBytes, options) {
  safeDirectory(root, cache);
  const file = path.join(cache, name);
  const verify = (candidate) => {
    const bytes = readRegular(candidate, sizeBytes || MAX_MANIFEST);
    requireCondition((!sizeBytes || bytes.length === sizeBytes) && sha256(bytes) === digest, `Bamboo release asset SHA-256 or size mismatch: ${name}`);
    return bytes;
  };
  if (exists(file)) return verify(file);
  requireCondition(!options.offline, `Offline Bamboo cache is missing ${name}; exact verified assets are required.`);
  const temporary = path.join(cache, `${name}.part-${process.pid}-${require("node:crypto").randomUUID()}`);
  fs.closeSync(fs.openSync(temporary, "wx", 0o600));
  try {
    (options.download || downloadAsset)(releaseUrl(lock, name), temporary, sizeBytes || MAX_MANIFEST);
    const bytes = verify(temporary);
    fs.renameSync(temporary, file);
    return bytes;
  } finally { fs.rmSync(temporary, { force: true }); }
}

function tarNumber(header, offset, length) {
  const value = header.subarray(offset, offset + length).toString("ascii").replace(/\0.*$/, "").trim();
  requireCondition(/^[0-7]+$/.test(value), "Browser host archive has an invalid tar number.");
  const number = parseInt(value, 8);
  requireCondition(Number.isSafeInteger(number), "Browser host tar number exceeds the safe range.");
  return number;
}

// A tiny, closed USTAR reader for this one three-file contract. It never invokes
// tar/unzip or writes any archive-selected path, link, permission or metadata.
function unpackHost(archive, host) {
  const maxOutputLength = host.files.reduce((total, item) => total + item.sizeBytes + 1024, 20480);
  const bytes = gunzipSync(archive, { maxOutputLength });
  const files = new Map();
  let offset = 0;
  for (; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 32 : header[index];
    requireCondition(tarNumber(header, 148, 8) === checksum, "Browser host tar checksum mismatch.");
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/, "");
    const name = field(0, 100);
    requireCondition(field(257, 6) === "ustar" && !field(345, 155) && !field(157, 100) &&
      [0, 48].includes(header[156]) && !(tarNumber(header, 100, 8) & 0o7000),
    "Browser host archive must use plain USTAR regular files without links or special entries.");
    const expected = host.files.find((item) => item.path === name);
    requireCondition(expected && !files.has(name), "Browser host archive contains an unexpected or duplicate path.");
    const size = tarNumber(header, 124, 12);
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    requireCondition(size === expected.sizeBytes && next <= bytes.length, "Browser host archive member size mismatch.");
    const contents = bytes.subarray(offset + 512, offset + 512 + size);
    requireCondition(sha256(contents) === expected.sha256, "Browser host archive member SHA-256 mismatch.");
    files.set(name, contents);
    offset = next;
  }
  requireCondition(files.size === HOST_FILES.length && bytes.length - offset >= 1024 &&
    bytes.subarray(offset).every((byte) => byte === 0), "Browser host archive is incomplete or has trailing data.");
  return files;
}

function verifyHost(root, directory, host) {
  safeDirectory(root, path.join(directory, "browser-runtime"));
  requireCondition(isDeepStrictEqual(fs.readdirSync(directory).sort(), ["browser-runtime"]) &&
    isDeepStrictEqual(fs.readdirSync(path.join(directory, "browser-runtime")).sort(), ["host.cjs", "package-lock.json", "package.json"]),
  "Cached browser host inventory differs from the release manifest.");
  for (const item of host.files) {
    const bytes = readRegular(path.join(directory, item.path), item.sizeBytes);
    requireCondition(bytes.length === item.sizeBytes && sha256(bytes) === item.sha256, "Cached browser host file SHA-256 or size mismatch.");
  }
  return directory;
}

function releaseContext(root, target, env) {
  const lock = readLock(root, env);
  requireCondition(TARGETS.includes(target), `Unsupported Bamboo sidecar target: ${target}`);
  if (env.TAURI_ENV_TARGET_TRIPLE) requireCondition(target === env.TAURI_ENV_TARGET_TRIPLE, "BAMBOO_SIDECAR_TARGET must match the Tauri build target.");
  const cache = path.join(root, "src-tauri", ".bamboo-sidecar-cache", lock.manifestSha256);
  return { lock, cache };
}

function installedRelease(root = ROOT, target, env = process.env) {
  const { lock, cache } = releaseContext(root, target, env);
  safeDirectory(root, cache);
  const manifestBytes = readRegular(path.join(cache, MANIFEST), MAX_MANIFEST);
  const { manifest, artifact } = validateManifest(manifestBytes, lock, target);
  const hostDirectory = verifyHost(root, path.join(cache, "browser-host"), manifest.browserHost);
  const binary = path.join(root, "src-tauri/binaries", binaryName(target));
  safeDirectory(root, path.dirname(binary));
  const bytes = readRegular(binary, artifact.sizeBytes);
  requireCondition(bytes.length === artifact.sizeBytes && sha256(bytes) === artifact.sha256, "Installed Bamboo sidecar SHA-256 or size mismatch.");
  require("./verify-assembly.cjs").verifySidecar(root, target);
  const receipt = JSON.parse(readRegular(`${binary}.json`, MAX_MANIFEST));
  requireCondition(isDeepStrictEqual(receipt, { schemaVersion: 1, version: lock.version, sourceRevision: lock.sourceRevision,
    target, buildMode: "embedded", embeddedFrontend: true, manifestSha256: lock.manifestSha256,
    assetName: artifact.assetName, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes,
    browserHostSha256: manifest.browserHost.sha256 }), "Installed Bamboo receipt differs from the accepted release.");
  return { ...receipt, binary, hostDirectory };
}

function installRelease(root = ROOT, target, options = {}) {
  const env = options.env || process.env;
  const { lock, cache } = releaseContext(root, target, env);
  const settings = { ...options, offline: options.offline ?? env.BAMBOO_SIDECAR_OFFLINE === "1" };
  const manifestBytes = cachedAsset(root, cache, lock, MANIFEST, lock.manifestSha256, null, settings);
  const { manifest, artifact } = validateManifest(manifestBytes, lock, target);
  const binaryBytes = cachedAsset(root, cache, lock, artifact.assetName, artifact.sha256, artifact.sizeBytes, settings);
  const hostArchive = cachedAsset(root, cache, lock, manifest.browserHost.assetName, manifest.browserHost.sha256, manifest.browserHost.sizeBytes, settings);
  const hostFiles = unpackHost(hostArchive, manifest.browserHost);
  const hostDirectory = path.join(cache, "browser-host");
  const binDir = safeDirectory(root, path.join(root, "src-tauri/binaries"));
  const scratch = fs.mkdtempSync(path.join(binDir, ".bamboo-stage-"));
  try {
    const stagedRoot = path.join(scratch, "candidate");
    const stagedBinary = path.join(safeDirectory(root, path.join(stagedRoot, "src-tauri/binaries")), binaryName(target));
    fs.writeFileSync(stagedBinary, binaryBytes, { mode: 0o755, flag: "wx" });
    require("./verify-assembly.cjs").verifySidecar(stagedRoot, target);
    if (exists(hostDirectory)) verifyHost(root, hostDirectory, manifest.browserHost);
    else {
      const stagedHost = safeDirectory(root, path.join(scratch, "host/browser-runtime"));
      for (const [name, bytes] of hostFiles) fs.writeFileSync(path.join(stagedHost, path.posix.basename(name)), bytes, { mode: 0o644, flag: "wx" });
      verifyHost(root, path.join(scratch, "host"), manifest.browserHost);
      fs.renameSync(path.join(scratch, "host"), hostDirectory);
    }
    const binary = path.join(binDir, binaryName(target));
    const receipt = { schemaVersion: 1, version: lock.version, sourceRevision: lock.sourceRevision, target,
      buildMode: "embedded", embeddedFrontend: true, manifestSha256: lock.manifestSha256,
      assetName: artifact.assetName, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes,
      browserHostSha256: manifest.browserHost.sha256 };
    for (const file of [binary, `${binary}.json`]) {
      try { requireCondition(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), `Refusing linked or non-file sidecar output: ${file}`); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    let same = false;
    if (fs.existsSync(binary)) {
      const old = readRegular(binary, MAX_BINARY);
      same = old.length === artifact.sizeBytes && sha256(old) === artifact.sha256;
    }
    if (!same) fs.renameSync(stagedBinary, binary);
    if (!target.includes("windows")) fs.chmodSync(binary, 0o755);
    const stagedReceipt = path.join(scratch, "receipt.json");
    fs.writeFileSync(stagedReceipt, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(stagedReceipt, `${binary}.json`);
    return installedRelease(root, target, env);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

module.exports = { HOST_FILES, MANIFEST, REPOSITORY, TARGETS, binaryName, downloadAsset, installRelease, installedRelease,
  readLock, releaseUrl, sha256, unpackHost, validateLock, validateManifest };

if (require.main === module) {
  try {
    const command = process.argv[2];
    if (command === "check-lock") readLock();
    else {
      requireCondition(["install", "verify"].includes(command), "Usage: bamboo-sidecar.cjs check-lock | install <target> | verify <target>");
      const result = (command === "install" ? installRelease : installedRelease)(ROOT, process.argv[3]);
      console.log(`Verified published Bamboo ${result.version} ${result.target} embedded (${result.sha256}).`);
    }
  } catch (error) { console.error(`Bamboo release: ${error.message}`); process.exitCode = 1; }
}
