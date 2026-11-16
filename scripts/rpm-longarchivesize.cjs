"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { parseArgs } = require("node:util");

// rpm2cpio 4.17 and 4.18 (Ubuntu 22.04 runners and 24.04) do:
//   payload_size = headerGetNumber(h, RPMTAG_LONGARCHIVESIZE);
//   exit(ufdCopy(decompressed_payload, stdout) == payload_size ? 0 : 1);
// A missing tag reads as 0, so a non-empty cpio payload still exits 1 with an
// empty message. The trusted main controller captures with `bash -o pipefail`,
// and that capture script is not the product tree. rpmReadPackageFile copies
// RPMSIGTAG_LONGARCHIVESIZE from the signature header into the main header
// when the main header does not already have it. The value is the uncompressed
// cpio length, which is what ufdCopy returns. The main header bytes stay put
// so the existing SHA256 header digest still verifies.

const LEAD_SIZE = 96;
const HEADER_MAGIC = Buffer.from("8eade80100000000", "hex");
const LEAD_MAGIC = Buffer.from("edabeedb", "hex");
const HEADERSIGNATURES = 62;
const LONGARCHIVESIZE = 271;
const PAYLOADCOMPRESSOR = 1125;
const TYPE_INT64 = 5;
const TYPE_STRING = 6;
const TYPE_BIN = 7;
const REGION_SIZE = 16;
const OPTIONS = {
  target: { type: "string", short: "t", multiple: true },
  bundles: { type: "string", short: "b", multiple: true },
  config: { type: "string", short: "c", multiple: true },
  runner: { type: "string", short: "r" },
  debug: { type: "boolean", short: "d" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
  "no-bundle": { type: "boolean" },
};

function fail(message) {
  throw new Error(message);
}

function readHeader(rpm, offset) {
  if (offset < 0 || offset + 16 > rpm.length || !rpm.subarray(offset, offset + 8).equals(HEADER_MAGIC)) {
    fail("RPM header magic is missing");
  }
  const nindex = rpm.readUInt32BE(offset + 8);
  const hsize = rpm.readUInt32BE(offset + 12);
  if (!Number.isInteger(nindex) || nindex < 1 || nindex > 0xffff || hsize > 0x0fffffff) fail("RPM header size is invalid");
  const dataStart = offset + 16 + nindex * 16;
  const dataEnd = dataStart + hsize;
  if (dataEnd > rpm.length) fail("RPM header is truncated");
  const entries = [];
  for (let index = 0; index < nindex; index += 1) {
    const at = offset + 16 + index * 16;
    entries.push({
      tag: rpm.readUInt32BE(at),
      type: rpm.readUInt32BE(at + 4),
      offset: rpm.readInt32BE(at + 8),
      count: rpm.readUInt32BE(at + 12),
    });
  }
  return { offset, nindex, hsize, dataStart, dataEnd, data: rpm.subarray(dataStart, dataEnd), entries };
}

function signaturePadding(headerLength) {
  return (8 - (headerLength % 8)) % 8;
}

function cString(data, offset) {
  const end = data.indexOf(0, offset);
  if (end < 0) fail("RPM string tag is not terminated");
  return data.toString("utf8", offset, end);
}

function tagString(header, tag) {
  const entry = header.entries.find((item) => item.tag === tag);
  if (!entry || entry.type !== TYPE_STRING || entry.count !== 1 || entry.offset < 0 || entry.offset >= header.data.length) {
    fail(`RPM tag ${tag} is not a single string`);
  }
  return cString(header.data, entry.offset);
}

function requireSignatureRegion(header) {
  const region = header.entries[0];
  if (!region || region.tag !== HEADERSIGNATURES || region.type !== TYPE_BIN || region.count !== REGION_SIZE) {
    fail("RPM signature header has no immutable region");
  }
  if (region.offset < 0 || region.offset + REGION_SIZE !== header.hsize) {
    fail("RPM signature region does not end the header");
  }
  const trailer = header.data.subarray(region.offset, region.offset + REGION_SIZE);
  const relative = trailer.readInt32BE(8);
  if (trailer.readUInt32BE(0) !== HEADERSIGNATURES || trailer.readUInt32BE(4) !== TYPE_BIN ||
      trailer.readUInt32BE(12) !== REGION_SIZE || relative >= 0 || relative % REGION_SIZE !== 0) {
    fail("RPM signature region trailer is invalid");
  }
  if ((-relative) / REGION_SIZE !== header.nindex) fail("RPM signature region does not cover every tag");
  for (const entry of header.entries.slice(1)) {
    if (entry.offset < 0 || entry.offset >= region.offset) fail(`RPM signature tag ${entry.tag} overlaps the region trailer`);
  }
  return region;
}

function writeEntry(buffer, at, entry) {
  buffer.writeUInt32BE(entry.tag, at);
  buffer.writeUInt32BE(entry.type, at + 4);
  buffer.writeInt32BE(entry.offset, at + 8);
  buffer.writeUInt32BE(entry.count, at + 12);
}

function buildHeader(entries, data) {
  const header = Buffer.alloc(16 + entries.length * 16 + data.length);
  HEADER_MAGIC.copy(header, 0);
  header.writeUInt32BE(entries.length, 8);
  header.writeUInt32BE(data.length, 12);
  entries.forEach((entry, index) => writeEntry(header, 16 + index * 16, entry));
  data.copy(header, 16 + entries.length * 16);
  return header;
}

function writeTrailer(data, at, entryCount) {
  data.writeUInt32BE(HEADERSIGNATURES, at);
  data.writeUInt32BE(TYPE_BIN, at + 4);
  data.writeInt32BE(-(entryCount * REGION_SIZE), at + 8);
  data.writeUInt32BE(REGION_SIZE, at + 12);
}

function gzipUncompressedSize(payload) {
  if (payload.length < 18 || payload[0] !== 0x1f || payload[1] !== 0x8b) fail("RPM payload is not a gzip stream");
  const bytes = zlib.gunzipSync(payload);
  if (!Number.isSafeInteger(bytes.length)) fail("RPM uncompressed payload does not fit an integer");
  return bytes.length;
}

function uncompressedPayloadSize(payload, compressor) {
  // Tauri CLI 2.5 / rpm-rs 0.16 defaults to gzip level 6. rpm2cpio opens
  // "r.<compressor>" and counts the decompressed bytes. Other compressors are
  // refused rather than recorded as the wrong length.
  if (compressor !== "gzip") fail(`Unsupported RPM payload compressor: ${compressor}`);
  return gzipUncompressedSize(payload);
}

function withLongArchiveSize(header, size) {
  const matches = header.entries.filter((entry) => entry.tag === LONGARCHIVESIZE);
  if (matches.length > 1) fail("RPM signature header has duplicate LONGARCHIVESIZE tags");
  const existing = matches[0];
  if (existing) {
    if (existing.type !== TYPE_INT64 || existing.count !== 1 || existing.offset < 0 || existing.offset % 8 !== 0 ||
        existing.offset + 8 > header.data.length) {
      fail("RPM signature LONGARCHIVESIZE has an unexpected layout");
    }
    if (header.data.readBigUInt64BE(existing.offset) === BigInt(size)) return null;
    const data = Buffer.from(header.data);
    data.writeBigUInt64BE(BigInt(size), existing.offset);
    return buildHeader(header.entries, data);
  }
  if (header.nindex + 1 > 32) fail("RPM signature header cannot fit LONGARCHIVESIZE");
  const trailerAt = header.entries[0].offset;
  const padding = (8 - (trailerAt % 8)) % 8;
  const valueAt = trailerAt + padding;
  const data = Buffer.alloc(valueAt + 8 + REGION_SIZE);
  header.data.copy(data, 0, 0, trailerAt);
  data.writeBigUInt64BE(BigInt(size), valueAt);
  const entries = header.entries.map((entry, index) => index === 0 ? { ...entry, offset: valueAt + 8 } : { ...entry });
  entries.push({ tag: LONGARCHIVESIZE, type: TYPE_INT64, offset: valueAt, count: 1 });
  writeTrailer(data, valueAt + 8, entries.length);
  return buildHeader(entries, data);
}

function addLongArchiveSize(rpm) {
  if (!Buffer.isBuffer(rpm) || rpm.length < LEAD_SIZE + 16 || !rpm.subarray(0, 4).equals(LEAD_MAGIC)) fail("Not an RPM package");
  const signature = readHeader(rpm, LEAD_SIZE);
  requireSignatureRegion(signature);
  const mainOffset = signature.dataEnd + signaturePadding(signature.dataEnd - signature.offset);
  const main = readHeader(rpm, mainOffset);
  if (main.entries.some((entry) => entry.tag === LONGARCHIVESIZE)) {
    fail("RPMTAG_LONGARCHIVESIZE is already in the main header");
  }
  const preserved = rpm.subarray(mainOffset);
  const size = uncompressedPayloadSize(preserved.subarray(main.dataEnd - mainOffset), tagString(main, PAYLOADCOMPRESSOR));
  const rewritten = withLongArchiveSize(signature, size);
  if (!rewritten) return rpm;
  const out = Buffer.concat([
    rpm.subarray(0, LEAD_SIZE),
    rewritten,
    Buffer.alloc(signaturePadding(rewritten.length)),
    preserved,
  ]);
  const check = readHeader(out, LEAD_SIZE);
  requireSignatureRegion(check);
  const recorded = check.entries.find((entry) => entry.tag === LONGARCHIVESIZE);
  if (!recorded || check.data.readBigUInt64BE(recorded.offset) !== BigInt(size)) fail("RPMTAG_LONGARCHIVESIZE was not recorded");
  const checkMain = check.dataEnd + signaturePadding(check.dataEnd - check.offset);
  if (!out.subarray(checkMain).equals(preserved)) fail("RPM main header or payload changed");
  return out;
}

function rewriteRpmFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) fail(`Expected a regular RPM file: ${file}`);
  const original = fs.readFileSync(file);
  const next = addLongArchiveSize(original);
  const signature = readHeader(next, LEAD_SIZE);
  const recorded = signature.entries.find((entry) => entry.tag === LONGARCHIVESIZE);
  const size = Number(signature.data.readBigUInt64BE(recorded.offset));
  if (next.equals(original)) return { file, size, changed: false };
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.longarchivesize`);
  try {
    fs.writeFileSync(temporary, next, { mode: stat.mode });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, stat.mode);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return { file, size, changed: true };
}

function bundleLayout(args) {
  const normalized = args.map((arg) => arg.replace(/^-t=/, "--target=").replace(/^-b=/, "--bundles="));
  let values;
  let tokens;
  try {
    ({ values, tokens } = parseArgs({ args: normalized, options: OPTIONS, tokens: true, strict: false, allowPositionals: true }));
  } catch (error) {
    fail(`Could not read tauri build arguments: ${error.message}`);
  }
  if (values["no-bundle"] || values.help || values.version) return null;
  const bundles = [];
  let sawBundles = false;
  for (const token of tokens) {
    if (token.kind === "option-terminator") break;
    if (token.kind === "option" && token.name === "bundles") {
      sawBundles = true;
      if (token.value) bundles.push(...token.value.split(",").filter(Boolean));
    }
  }
  if (sawBundles && !bundles.includes("rpm")) return null;
  const targets = (values.target || []).map((target) => target.trim()).filter(Boolean);
  return { targets: targets.length ? targets : [undefined], profile: values.debug ? "debug" : "release" };
}

function isDirectory(directory) {
  try { return fs.statSync(directory).isDirectory(); }
  catch { return false; }
}

function rpmFilesIn(directory) {
  if (!isDirectory(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith(".rpm")).sort().map((name) => path.join(directory, name));
}

function rpmDirectories(root, layout) {
  const directories = [];
  for (const target of layout.targets) {
    for (const base of ["target", path.join("src-tauri", "target")]) {
      directories.push(path.join(root, base, ...(target ? [target] : []), layout.profile, "bundle", "rpm"));
    }
  }
  return directories;
}

function findBuiltRpms(root, layout) {
  const files = [];
  for (const directory of rpmDirectories(root, layout)) files.push(...rpmFilesIn(directory));
  if (layout.targets.length === 1 && layout.targets[0] === undefined) {
    for (const base of ["target", path.join("src-tauri", "target")]) {
      const parent = path.join(root, base);
      if (!isDirectory(parent)) continue;
      for (const name of fs.readdirSync(parent)) {
        files.push(...rpmFilesIn(path.join(parent, name, layout.profile, "bundle", "rpm")));
      }
    }
  }
  return [...new Set(files)];
}

function rewriteBuiltRpms(root, args) {
  const layout = bundleLayout(args);
  if (!layout) return [];
  const changed = [];
  for (const file of findBuiltRpms(root, layout)) {
    const result = rewriteRpmFile(file);
    if (result.changed) {
      console.log(`RPM longarchivesize: recorded ${result.size} uncompressed payload bytes in ${result.file}`);
      changed.push(result.file);
    }
  }
  return changed;
}

module.exports = { addLongArchiveSize, rewriteRpmFile, rewriteBuiltRpms };
