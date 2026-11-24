"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const out = require("./release-output.cjs");
const { captureWindows, readPeProductVersion } = require("./v37-winarm-original.cjs");

const align = offset => Math.ceil(offset / 4) * 4;

function block(key, type, value, children = []) {
  const encoded = Buffer.from(key + "\0", "utf16le");
  const start = align(6 + encoded.length);
  const nested = align(start + value.length);
  const result = Buffer.alloc(nested + children.reduce((length, child) => length + child.length, 0));
  result.writeUInt16LE(result.length, 0);
  result.writeUInt16LE(type === 1 ? value.length / 2 : value.length, 2);
  result.writeUInt16LE(type, 4);
  encoded.copy(result, 6);
  value.copy(result, start);
  let offset = nested;
  for (const child of children) {
    child.copy(result, offset);
    offset += child.length;
  }
  return result;
}

function pe({ productKey = "ProductVersion", duplicate = false } = {}) {
  const value = block(productKey, 1, Buffer.from("2026.11.37\0", "utf16le"));
  const table = block("000004b0", 1, Buffer.alloc(0), duplicate ? [value, value] : [value]);
  const strings = block("StringFileInfo", 1, Buffer.alloc(0), [table]);
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd);
  const version = block("VS_VERSION_INFO", 0, fixed, [strings]);
  const resources = Buffer.alloc(88 + version.length);
  for (const [start, id, next] of [[0, 16, 0x80000018], [24, 1, 0x80000030], [48, 1033, 72]]) {
    resources.writeUInt16LE(1, start + 14);
    resources.writeUInt32LE(id, start + 16);
    resources.writeUInt32LE(next, start + 20);
  }
  resources.writeUInt32LE(0x1000 + 88, 72);
  resources.writeUInt32LE(version.length, 76);
  version.copy(resources, 88);
  const program = Buffer.alloc(512 + resources.length);
  program.write("MZ");
  program.writeUInt32LE(64, 60);
  program.writeUInt32LE(0x4550, 64);
  program.writeUInt16LE(0xaa64, 68);
  program.writeUInt16LE(1, 70);
  program.writeUInt16LE(136, 84);
  program.writeUInt16LE(0x20b, 88);
  program.writeUInt32LE(3, 196);
  program.writeUInt32LE(0x1000, 216);
  program.writeUInt32LE(resources.length, 220);
  program.writeUInt32LE(0x1000, 236);
  program.writeUInt32LE(resources.length, 240);
  program.writeUInt32LE(512, 244);
  resources.copy(program, 512);
  return program;
}

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-v37-winarm-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("reads only the PE version resource and rejects missing or duplicate ProductVersion", t => {
  const file = path.join(scratch(t), "bodhi.exe");
  fs.writeFileSync(file, pe());
  assert.equal(readPeProductVersion(file), "2026.11.37");
  fs.writeFileSync(file, pe({ productKey: "FileVersion" }));
  assert.throws(() => readPeProductVersion(file), /Expected one ProductVersion/);
  fs.writeFileSync(file, pe({ duplicate: true }));
  assert.throws(() => readPeProductVersion(file), /Expected one ProductVersion/);
});

test("rejects truncated or oversized PE resource reads", t => {
  const file = path.join(scratch(t), "bodhi.exe");
  const truncated = pe().subarray(0, -1);
  fs.writeFileSync(file, truncated);
  assert.throws(() => readPeProductVersion(file), /Invalid PE resources bounds/);
  const oversized = pe();
  oversized.writeUInt32LE(0xffffffff, 220);
  fs.writeFileSync(file, oversized);
  assert.throws(() => readPeProductVersion(file), /Invalid PE resource table size/);
});

test("rejects altered ZIP bytes before looking up the source or creating the destination", t => {
  const root = scratch(t);
  const zip = path.join(root, "original.zip");
  const directory = path.join(root, "output");
  fs.writeFileSync(zip, "altered");
  const ctx = {
    source: "84a0181d5875a6b91cd847e060e9255a56a378bf",
    version: "2026.11.37", runId: 45432961380, attempt: 1, thin: true, producer: out.THIN_RELEASE_WORKFLOW_BLOB,
  };
  assert.throws(() => captureWindows({
    zip, directory, ctx, reservation: {}, job: { id: 138583610124, run_attempt: 1 },
    digest: "sha256:5547b5166f9476cef0f8c05a91f7ea3639060a8793e22f27e25cffff09f65d8f",
    request: () => assert.fail("Unexpected source request"),
  }), /Saved Windows ZIP digest differs/);
  assert.equal(fs.existsSync(directory), false);
});

const original = process.env.BODHI_SAVED_WINARM_ZIP;
test("reads ProductVersion from the authenticated original Windows ARM64 executable", { skip: !original }, t => {
  assert.equal(out.hashFile(original), "5547b5166f9476cef0f8c05a91f7ea3639060a8793e22f27e25cffff09f65d8f");
  const file = path.join(scratch(t), "bodhi.exe");
  const entry = "Bodhi-AI/Bodhi-AI/product/target/aarch64-pc-windows-msvc/release/bodhi.exe";
  fs.writeFileSync(file, execFileSync("unzip", ["-p", original, entry], { maxBuffer: 32 * 1024 ** 2 }));
  assert.equal(readPeProductVersion(file), "2026.11.37");
});
