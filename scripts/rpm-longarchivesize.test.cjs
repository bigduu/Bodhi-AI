"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const { addLongArchiveSize, rewriteBuiltRpms, rewriteRpmFile } = require("./rpm-longarchivesize.cjs");

const FIXTURE = path.join(__dirname, "tests/fixtures/rpm-rs-no-longarchivesize.rpm");
const HEADER_MAGIC = Buffer.from("8eade80100000000", "hex");
const X64 = "x86_64-unknown-linux-gnu";
const ARM = "aarch64-unknown-linux-gnu";
const RELEASE_ARGS = (target) => ["--target", target, "--bundles", "appimage,deb,rpm", "--verbose"];

function toolAvailable(name) {
  try {
    execFileSync("bash", ["-c", 'command -v "$1"', "tool", name], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

function signature(rpm) {
  assert.ok(rpm.subarray(96, 104).equals(HEADER_MAGIC), "signature header magic");
  const nindex = rpm.readUInt32BE(104);
  const hsize = rpm.readUInt32BE(108);
  const dataStart = 112 + nindex * 16;
  const entries = [];
  for (let index = 0; index < nindex; index += 1) {
    const at = 112 + index * 16;
    entries.push({
      tag: rpm.readUInt32BE(at),
      type: rpm.readUInt32BE(at + 4),
      offset: rpm.readInt32BE(at + 8),
      count: rpm.readUInt32BE(at + 12),
    });
  }
  return { nindex, hsize, dataStart, dataEnd: dataStart + hsize, entries, data: rpm.subarray(dataStart, dataStart + hsize) };
}

function afterSignature(rpm) {
  const sig = signature(rpm);
  const pad = (8 - ((sig.dataEnd - 96) % 8)) % 8;
  return rpm.subarray(sig.dataEnd + pad);
}

function mainHeader(rpm) {
  const body = afterSignature(rpm);
  assert.ok(body.subarray(0, 8).equals(HEADER_MAGIC), "main header magic");
  const nindex = body.readUInt32BE(8);
  const hsize = body.readUInt32BE(12);
  return body.subarray(0, 16 + nindex * 16 + hsize);
}

function archiveSize(rpm) {
  const sig = signature(rpm);
  const entry = sig.entries.find((item) => item.tag === 271);
  assert.ok(entry, "RPMTAG_LONGARCHIVESIZE is missing");
  assert.equal(entry.type, 5);
  assert.equal(entry.count, 1);
  assert.equal(entry.offset % 8, 0);
  const value = sig.data.readBigUInt64BE(entry.offset);
  assert.ok(value <= BigInt(Number.MAX_SAFE_INTEGER));
  return Number(value);
}

function regionCoversHeader(rpm) {
  const sig = signature(rpm);
  const region = sig.entries[0];
  assert.equal(region.tag, 62);
  assert.equal(region.type, 7);
  assert.equal(region.count, 16);
  assert.equal(region.offset + 16, sig.hsize);
  const trailer = sig.data.subarray(region.offset, region.offset + 16);
  assert.equal(trailer.readUInt32BE(0), 62);
  assert.equal(trailer.readInt32BE(8), -sig.nindex * 16);
  assert.equal(trailer.readUInt32BE(12), 16);
}

test("an rpm-rs package gains LONGARCHIVESIZE without changing the signed header or payload", () => {
  const original = fs.readFileSync(FIXTURE);
  assert.equal(signature(original).entries.some((entry) => entry.tag === 271), false);
  const rewritten = addLongArchiveSize(original);
  assert.equal(archiveSize(rewritten), zlib.gunzipSync(afterSignature(original).subarray(mainHeader(original).length)).length);
  assert.equal(archiveSize(rewritten), 568);
  regionCoversHeader(rewritten);
  assert.ok(mainHeader(original).equals(mainHeader(rewritten)));
  assert.ok(afterSignature(original).equals(afterSignature(rewritten)));
  const recorded = signature(rewritten).data.toString("utf8", signature(rewritten).entries.find((entry) => entry.tag === 273).offset, signature(rewritten).entries.find((entry) => entry.tag === 273).offset + 64);
  assert.equal(createHash("sha256").update(mainHeader(rewritten)).digest("hex"), recorded);
  assert.ok(addLongArchiveSize(rewritten).equals(rewritten));
  const broken = Buffer.from(rewritten);
  const sig = signature(broken);
  const entry = sig.entries.find((item) => item.tag === 271);
  broken.writeBigUInt64BE(1n, sig.dataStart + entry.offset);
  const repaired = addLongArchiveSize(broken);
  assert.equal(archiveSize(repaired), 568);
  assert.ok(afterSignature(repaired).equals(afterSignature(original)));
});

test("rewrite refuses a non-package and a compressor other than gzip", () => {
  assert.throws(() => addLongArchiveSize(Buffer.from("not an rpm")), /Not an RPM package/);
  const swapped = Buffer.from(fs.readFileSync(FIXTURE));
  const marker = Buffer.from("gzip\0");
  const at = swapped.indexOf(marker);
  assert.equal(at, swapped.lastIndexOf(marker));
  Buffer.from("zstd\0").copy(swapped, at);
  assert.throws(() => addLongArchiveSize(swapped), /Unsupported RPM payload compressor: zstd/);
});

test("both linux release layouts are stamped and other bundles are left alone", (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bodhi-rpm-stamp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const place = (target, profile, base = "target") => {
    const file = path.join(root, base, target, profile, "bundle", "rpm", `Bodhi AI-2026.11.19-1.${target.startsWith("aarch64") ? "aarch64" : "x86_64"}.rpm`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(FIXTURE, file);
    return file;
  };
  const x64 = place(X64, "release");
  const arm = place(ARM, "release");
  const debug = place(X64, "debug");
  const nested = place(ARM, "release", path.join("src-tauri", "target"));
  const original = fs.readFileSync(FIXTURE);
  assert.deepEqual(rewriteBuiltRpms(root, ["--target", X64, "--bundles", "deb,appimage", "--verbose"]), []);
  assert.ok(fs.readFileSync(x64).equals(original));
  assert.deepEqual(rewriteBuiltRpms(root, RELEASE_ARGS(X64)), [x64]);
  assert.equal(archiveSize(fs.readFileSync(x64)), 568);
  assert.ok(fs.readFileSync(arm).equals(original));
  assert.ok(fs.readFileSync(debug).equals(original));
  assert.ok(fs.readFileSync(nested).equals(original));
  assert.deepEqual(rewriteBuiltRpms(root, ["--target", ARM, "--bundles=appimage,deb,rpm"]).sort(), [arm, nested].sort());
  assert.equal(archiveSize(fs.readFileSync(arm)), 568);
  assert.equal(archiveSize(fs.readFileSync(nested)), 568);
  assert.ok(fs.readFileSync(debug).equals(original));
  assert.deepEqual(rewriteBuiltRpms(root, ["-t", X64, "-b", "rpm", "--debug"]), [debug]);
  assert.equal(archiveSize(fs.readFileSync(debug)), 568);
  assert.deepEqual(rewriteBuiltRpms(root, ["--no-bundle"]), []);
  const again = rewriteRpmFile(x64);
  assert.equal(again.changed, false);
  assert.equal(again.size, 568);
});

test("rpm2cpio 4.18 extracts the rewritten rpm-rs payload with exit 0", {
  skip: !toolAvailable("bash") || !toolAvailable("cpio") || !toolAvailable("rpm2cpio") || !toolAvailable("rpm"),
}, (t) => {
  const version = execFileSync("rpm", ["--version"], { encoding: "utf8" });
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bodhi-rpm-rpm2cpio-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "Bodhi AI-2026.11.19-1.aarch64.rpm");
  fs.copyFileSync(FIXTURE, file);
  const run = (program, args, options = {}) => {
    try {
      return { status: 0, stdout: execFileSync(program, args, { ...options, stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (error) {
      return { status: error.status, stdout: error.stdout, stderr: error.stderr };
    }
  };
  const before = run("rpm2cpio", [file]);
  const legacy = /^RPM version 4\.(17|18)\b/.test(version.trim());
  if (legacy) {
    assert.equal(before.status, 1, version);
    assert.equal(before.stderr.length, 0);
    assert.equal(before.stdout.length, 568);
  }
  const pipefail = (directory) => run("bash", ["-o", "pipefail", "-c",
    'rpm2cpio "$1" | cpio -id --no-absolute-filenames --quiet', "bodhi-rpm-payload", file], { cwd: directory });
  if (legacy) {
    const failed = path.join(root, "pipefail-before");
    fs.mkdirSync(failed);
    assert.notEqual(pipefail(failed).status, 0);
  }
  const stamped = rewriteRpmFile(file);
  assert.equal(stamped.changed, true);
  assert.equal(stamped.size, 568);
  const after = run("rpm2cpio", [file]);
  assert.equal(after.status, 0, after.stderr && after.stderr.toString());
  assert.ok(after.stdout.equals(before.stdout));
  const query = execFileSync("rpm", ["-qp", "--queryformat", "%{VERSION}|%{RELEASE}|%{ARCH}|%{LONGARCHIVESIZE}", file], { encoding: "utf8" });
  assert.equal(query, "2026.11.19|1|aarch64|568");
  const extracted = path.join(root, "extracted");
  fs.mkdirSync(extracted);
  const captured = pipefail(extracted);
  assert.equal(captured.status, 0, captured.stderr && captured.stderr.toString());
  assert.equal(fs.readFileSync(path.join(extracted, "usr/lib/Bodhi AI/host.cjs"), "utf8"), "console.log('hello')\n");
  assert.equal(fs.readFileSync(path.join(extracted, "usr/bin/bodhi")).length, 18);
});
