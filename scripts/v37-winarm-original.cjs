"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const out = require("./release-output.cjs");
const { verifyArchitecture } = require("./browser-runtime.cjs");
const { verifyInstallerPayload } = require("./installer-payload.cjs");

const TARGET = "aarch64-pc-windows-msvc";
const SOURCE = "84a0181d5875a6b91cd847e060e9255a56a378bf";
const VERSION = "2026.11.37";
const JOB_ID = 138583610124;
const RUN_ID = 45432961380;
const ZIP_DIGEST = "sha256:5547b5166f9476cef0f8c05a91f7ea3639060a8793e22f27e25cffff09f65d8f";
const PREFIX = "Bodhi-AI/Bodhi-AI/product/";
const STAMPS = ["src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "Cargo.lock"];
const UNSTAMPED = ["yarn.lock", "package-lock.json", "scripts/frontend-package-lock.json",
  "scripts/bamboo-sidecar-lock.json", "scripts/browser-runtime.lock.json"];
const MAX_PE = 32 * 1024 ** 2;
const MAX_SOURCE_FILE = 512 * 1024;
const DIRECTORY_FLAG = 0x80000000;
const align = offset => Math.ceil(offset / 4) * 4;

function span(bytes, offset, length, label) {
  assert.ok(Number.isSafeInteger(offset) && Number.isSafeInteger(length) &&
    offset >= 0 && length >= 0 && offset + length <= bytes.length, `Invalid ${label} bounds`);
  return bytes.subarray(offset, offset + length);
}

function resourceTable(bytes) {
  const dos = span(bytes, 0, 64, "DOS header");
  assert.equal(dos.toString("ascii", 0, 2), "MZ");
  const peOffset = dos.readUInt32LE(60);
  assert.ok(peOffset >= dos.length, "PE header overlaps the DOS header");
  const pe = span(bytes, peOffset, 24, "PE header");
  assert.equal(pe.readUInt32LE(), 0x4550);
  const optional = span(bytes, peOffset + pe.length, pe.readUInt16LE(20), "PE optional header");
  assert.ok(optional.length >= 136 && optional.readUInt16LE() === 0x20b &&
    optional.readUInt32LE(108) >= 3, "Expected a PE32+ resource directory");
  const rva = optional.readUInt32LE(128);
  const length = optional.readUInt32LE(132);
  assert.ok(rva > 0 && length >= 16 && length <= 4 * 1024 ** 2, "Invalid PE resource table size");
  const sections = pe.readUInt16LE(6);
  assert.ok(sections > 0 && sections <= 96, "Invalid PE section count");
  const table = span(bytes, peOffset + pe.length + optional.length, sections * 40, "PE section table");
  const offsets = [];
  for (let offset = 0; offset < table.length; offset += 40) {
    const displacement = rva - table.readUInt32LE(offset + 12);
    const rawSize = table.readUInt32LE(offset + 16);
    if (displacement >= 0 && displacement + length <= rawSize) offsets.push(table.readUInt32LE(offset + 20) + displacement);
  }
  assert.equal(offsets.length, 1, "Expected one PE section containing the resources");
  return { bytes: span(bytes, offsets[0], length, "PE resources"), rva };
}

function resourceEntries(bytes, offset) {
  const header = span(bytes, offset, 16, "resource directory");
  const count = header.readUInt16LE(12) + header.readUInt16LE(14);
  const entries = span(bytes, offset + header.length, count * 8, "resource entries");
  return Array.from({ length: count }, (_, index) => ({
    id: entries.readUInt32LE(index * 8),
    offset: entries.readUInt32LE(index * 8 + 4),
  }));
}

function only(entries, label) {
  assert.equal(entries.length, 1, `Expected one ${label}`);
  return entries[0];
}

function childResources(bytes, entry) {
  assert.ok(entry.offset >= DIRECTORY_FLAG, "Expected a nested PE resource directory");
  return resourceEntries(bytes, entry.offset - DIRECTORY_FLAG);
}

function versionResource(table) {
  const type = only(resourceEntries(table.bytes, 0).filter(entry => entry.id === 16), "PE version resource type");
  const name = only(childResources(table.bytes, type), "PE version resource name");
  const language = only(childResources(table.bytes, name), "PE version resource language");
  assert.ok(language.offset < DIRECTORY_FLAG, "Expected PE version resource data");
  const entry = span(table.bytes, language.offset, 16, "PE version resource entry");
  const length = entry.readUInt32LE(4);
  assert.ok(length >= 8 && length <= 65535, "Invalid PE version resource size");
  return span(table.bytes, entry.readUInt32LE() - table.rva, length, "PE version resource");
}

function versionBlock(bytes, offset, limit) {
  const header = span(bytes, offset, 6, "version block header");
  const end = offset + header.readUInt16LE();
  const type = header.readUInt16LE(4);
  assert.ok(end >= offset + 8 && end <= limit && (type === 0 || type === 1), "Invalid version block");
  const keyStart = offset + header.length;
  let keyEnd = keyStart;
  while (keyEnd + 2 <= end && bytes.readUInt16LE(keyEnd) !== 0) keyEnd += 2;
  assert.ok(keyEnd > keyStart && keyEnd + 2 <= end, "Unterminated version key");
  const valueStart = align(keyEnd + 2);
  const valueLength = header.readUInt16LE(2) * (type === 1 ? 2 : 1);
  assert.ok(valueStart + valueLength <= end, "Version block value exceeds its bounds");
  return {
    key: bytes.toString("utf16le", keyStart, keyEnd),
    value: span(bytes, valueStart, valueLength, "version block value"),
    children: align(valueStart + valueLength), end, type,
  };
}

function blocks(bytes, parent) {
  const result = [];
  let offset = parent.children;
  while (offset < parent.end) {
    const block = versionBlock(bytes, offset, parent.end);
    result.push(block);
    offset = align(block.end);
  }
  return result;
}

function readPeProductVersion(file) {
  assert.ok(fs.lstatSync(file).isFile() && fs.statSync(file).size <= MAX_PE, "Invalid saved PE file");
  const resource = versionResource(resourceTable(fs.readFileSync(file)));
  const root = versionBlock(resource, 0, resource.length);
  assert.equal(root.end, resource.length);
  assert.equal(root.key, "VS_VERSION_INFO");
  assert.ok(root.type === 0 && root.value.length === 52 && root.value.readUInt32LE() === 0xfeef04bd,
    "Invalid PE fixed version info");
  const strings = only(blocks(resource, root).filter(block => block.key === "StringFileInfo"), "StringFileInfo");
  const table = only(blocks(resource, strings), "PE version string table");
  const product = only(blocks(resource, table).filter(block => block.key === "ProductVersion"), "ProductVersion");
  const version = product.value.toString("utf16le");
  assert.ok(product.type === 1 && /^\d+\.\d+\.\d+(?:\.\d+)?\0$/.test(version), "Invalid PE ProductVersion");
  return version.slice(0, -1);
}

function zipEntries(zip, expected) {
  const listing = execFileSync("unzip", ["-Z", "-l", zip], {
    env: { ...out.childEnv(), LC_ALL: "C" }, encoding: "utf8", maxBuffer: 64 * 1024, timeout: 15000,
  }).trimEnd().split(/\r?\n/);
  assert.equal(listing.length, expected.size + 3, "Unexpected original ZIP entry count");
  const found = new Map();
  for (const line of listing.slice(2, -1)) {
    const entry = /^-[rwx-]{9}\s+\S+\s+unx\s+(\d+)\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line);
    assert.ok(entry, "Expected a regular original ZIP entry");
    const [, length, name] = entry;
    const size = Number(length);
    assert.ok(expected.has(name) && !found.has(name), "Unexpected or duplicate original ZIP entry");
    assert.ok(size > 0 && size <= expected.get(name), "Original ZIP entry exceeds its size limit");
    found.set(name, size);
  }
  return found;
}

function sourceBytes(file, request) {
  const blob = request(`contents/${file}?ref=${SOURCE}`);
  assert.ok(blob?.type === "file" && blob.encoding === "base64" && blob.size > 0 &&
    blob.size <= MAX_SOURCE_FILE && typeof blob.content === "string", `Invalid original source blob: ${file}`);
  const bytes = Buffer.from(blob.content, "base64");
  assert.equal(bytes.length, blob.size, `Original source blob size differs: ${file}`);
  return bytes;
}

function captureWindows({ zip, directory, ctx, reservation, job, digest, request = out.api }) {
  assert.equal(ctx.source, SOURCE);
  assert.equal(ctx.version, VERSION);
  assert.equal(ctx.runId, RUN_ID);
  assert.equal(out.releaseContract(ctx).schemaVersion, 4);
  assert.equal(job.id, JOB_ID);
  assert.equal(job.run_attempt, 1);
  assert.ok(path.isAbsolute(directory) && !fs.existsSync(directory), "Restore destination must be new");
  assert.equal(digest, ZIP_DIGEST, "Unexpected saved Windows ZIP identity");
  assert.equal(`sha256:${out.hashFile(zip)}`, ZIP_DIGEST, "Saved Windows ZIP digest differs");

  const [name] = out.names(VERSION, TARGET);
  const target = `target/${TARGET}/release`;
  const shellPath = `${target}/bodhi.exe`;
  const installerPath = `${target}/bundle/nsis/${name.replace("Bodhi.AI", "Bodhi AI")}`;
  const expected = new Map([
    [PREFIX + shellPath, MAX_PE], [PREFIX + installerPath, MAX_PE],
    [`${PREFIX}${target}/bodhi.pdb`, MAX_PE], [`${PREFIX}${target}/bodhi.d`, MAX_SOURCE_FILE],
    ...[...STAMPS, ...UNSTAMPED].map(file => [PREFIX + file, MAX_SOURCE_FILE]),
  ]);
  const entries = zipEntries(zip, expected);
  const extract = file => {
    const entry = PREFIX + file;
    const bytes = execFileSync("unzip", ["-p", zip, entry], {
      env: out.childEnv(), maxBuffer: entries.get(entry), timeout: 15000,
    });
    assert.equal(bytes.length, entries.get(entry), `Saved ZIP entry size differs: ${file}`);
    return bytes;
  };
  const originals = STAMPS.map(file => sourceBytes(file, request).toString("utf8"));
  for (const [file, data] of Object.entries(out.stamped(...originals, VERSION))) {
    assert.ok(extract(file).equals(Buffer.from(data)), `Saved version stamp differs: ${file}`);
  }
  for (const file of UNSTAMPED) {
    assert.ok(extract(file).equals(sourceBytes(file, request)), `Saved source file differs: ${file}`);
  }

  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const scratch = fs.mkdtempSync(path.join(path.dirname(directory), ".saved-winarm-"));
  try {
    const shell = path.join(scratch, "bodhi.exe");
    const installer = path.join(scratch, name);
    fs.writeFileSync(shell, extract(shellPath), { flag: "wx" });
    fs.writeFileSync(installer, extract(installerPath), { flag: "wx" });
    verifyArchitecture(shell, TARGET);
    const actual = readPeProductVersion(shell);
    assert.ok(actual === VERSION || actual === `${VERSION}.0`, "Shell PE version differs");
    verifyInstallerPayload({ format: "nsis", file: installer, target: TARGET, shell, thin: true }, out.childEnv());
    const receipt = {
      schemaVersion: 4, target: TARGET, reservationSha256: out.sha256(out.bytes(reservation)),
      jobId: job.id, attempt: job.run_attempt, checks: out.checks(TARGET, 4),
      files: [{ name, size: fs.statSync(installer).size, sha256: out.hashFile(installer) }],
    };
    out.verifyReceipt(receipt, ctx, reservation, TARGET, job);
    out.write(path.join(scratch, "target-receipt.json"), receipt);
    fs.unlinkSync(shell);
    assert.ok(!fs.existsSync(directory), "Restore destination appeared during verification");
    fs.renameSync(scratch, directory);
    return { receipt, directory };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { captureWindows, readPeProductVersion };
