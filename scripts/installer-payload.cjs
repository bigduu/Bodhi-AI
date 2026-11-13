"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { sha256File, verifyArchitecture } = require("./browser-runtime.cjs");
const { verifyBundledRuntime, verifyFrontendDirectory } = require("./verify-assembly.cjs");

// Tauri's Linux packages share usr/bin and usr/lib/<product>. NSIS extracts
// the installed files directly into its output directory.
function payloadLayout(format) {
  if (format === "nsis") return { root: ".", bin: ".", resources: ".", extension: ".exe" };
  assert.ok(["appimage", "deb", "rpm"].includes(format), "Unsupported installer format");
  return { root: format === "appimage" ? "squashfs-root" : ".", bin: "usr/bin", resources: "usr/lib/Bodhi AI", extension: "" };
}

function appImageOffset(file) {
  const descriptor = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(64);
    const lastSection = Buffer.alloc(64);
    const fileSize = fs.fstatSync(descriptor, { bigint: true }).size;
    assert.equal(fs.readSync(descriptor, header, 0, header.length, 0), header.length, "Short AppImage ELF header");
    assert.ok(header.subarray(0, 7).toString("hex") === "7f454c46020101" &&
      header.subarray(8, 11).toString("hex") === "414902", "Expected a little-endian 64-bit type 2 AppImage");
    const sections = header.readBigUInt64LE(40);
    const sectionSize = header.readUInt16LE(58);
    const sectionCount = header.readUInt16LE(60);
    const tableEnd = sections + BigInt(sectionSize * sectionCount);
    assert.ok(sections >= 64n && sectionSize === lastSection.length && sectionCount > 0 &&
      tableEnd <= fileSize && tableEnd <= BigInt(Number.MAX_SAFE_INTEGER), "Invalid AppImage ELF section table");
    assert.equal(fs.readSync(descriptor, lastSection, 0, lastSection.length, Number(tableEnd) - sectionSize),
      lastSection.length, "Short AppImage ELF section header");
    // The type 2 runtime starts SquashFS after the section table and last section.
    const lastSectionEnd = lastSection.readBigUInt64LE(24) + lastSection.readBigUInt64LE(32);
    const offset = tableEnd > lastSectionEnd ? tableEnd : lastSectionEnd;
    assert.ok(offset + 4n <= fileSize && offset <= BigInt(Number.MAX_SAFE_INTEGER), "Invalid AppImage SquashFS offset");
    const magic = Buffer.alloc(4);
    assert.equal(fs.readSync(descriptor, magic, 0, magic.length, Number(offset)), magic.length);
    assert.equal(magic.toString("ascii"), "hsqs", "Missing AppImage SquashFS payload");
    return offset.toString();
  } finally { fs.closeSync(descriptor); }
}

function extract(format, file, directory, run) {
  if (format === "appimage") {
    run("unsquashfs", ["-no-progress", "-offset", appImageOffset(file), "-d", path.join(directory, "squashfs-root"), file], { cwd: directory });
  } else if (format === "deb") {
    run("dpkg-deb", ["--extract", file, directory], { cwd: directory });
  } else if (format === "rpm") {
    // Shell owns the stream, while paths stay arguments rather than script text.
    run("bash", ["-o", "pipefail", "-c", 'rpm2cpio "$1" | cpio -id --no-absolute-filenames --quiet',
      "bodhi-rpm-payload", file], { cwd: directory });
  } else {
    run("7z", ["x", "-y", "-bb0", "-bso0", `-o${directory}`, "--", file], { cwd: directory });
  }
}

function ownedPath(root, parts, directory = false) {
  let current = root;
  for (const [index, part] of parts.entries()) {
    if (part === ".") continue;
    current = path.join(current, part);
    const entry = fs.lstatSync(current);
    const final = index === parts.length - 1;
    assert.ok(!entry.isSymbolicLink() && (final && !directory ? entry.isFile() : entry.isDirectory()),
      `Unexpected installer payload entry: ${parts.join("/")}`);
  }
  assert.ok(path.resolve(current) === fs.realpathSync(current), "Installer payload escapes its extraction directory");
  return current;
}

function extractedPaths(directory, format) {
  const layout = payloadLayout(format);
  const root = ownedPath(directory, [layout.root], true);
  const bin = layout.bin.split("/");
  const resources = layout.resources.split("/");
  return {
    bodhi: ownedPath(root, [...bin, `bodhi${layout.extension}`]),
    bamboo: ownedPath(root, [...bin, `bamboo${layout.extension}`]),
    browser: ownedPath(root, [...resources, "browser-runtime"], true),
    frontend: ownedPath(root, [...resources, "frontend"], true),
  };
}

function readTextSection(file, directory, role, run) {
  const output = path.join(directory, `${role}.text`);
  // An explicit outfile keeps objcopy from rewriting the original ELF.
  run("objcopy", ["--dump-section", `.text=${output}`, file, "/dev/null"], { cwd: directory });
  assert.ok(fs.statSync(output).size > 0, "Missing executable .text section");
  return output;
}

function verifyInstallerPayload({ format, file, target, shell, sidecar, browserRoot, browserLock, frontendReceipt, appDir }, env) {
  const layout = payloadLayout(format);
  assert.equal(target.includes("windows"), layout.extension === ".exe", "Installer format differs from the selected target");
  const { PATH, HOME, USERPROFILE, SystemRoot, TEMP, TMP, TMPDIR, LANG, LC_ALL } = env;
  const toolingEnv = Object.fromEntries(Object.entries({ PATH, HOME, USERPROFILE, SystemRoot, TEMP, TMP, TMPDIR, LANG, LC_ALL })
    .filter(([, value]) => value !== undefined));
  if (format === "appimage") {
    assert.ok(typeof appDir === "string" && path.isAbsolute(appDir), "Missing the built AppDir for this AppImage");
    verifyArchitecture(file, target);
  }
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bodhi-installer-payload-"));
  const run = (program, args, options) => execFileSync(program, args, {
    ...options, env: toolingEnv, timeout: 10 * 60 * 1000, stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    extract(format, file, directory, run);
    const payload = extractedPaths(directory, format);
    for (const [name, original] of [["bodhi", shell], ["bamboo", sidecar]]) {
      verifyArchitecture(payload[name], target);
      if (layout.extension === "" && process.platform !== "win32") {
        assert.ok(fs.statSync(payload[name]).mode & 0o111, `Installed ${name} is not executable`);
      }
      const installed = sha256File(payload[name]);
      const staged = sha256File(original);
      if (format === "appimage") {
        const packed = ownedPath(appDir, ["usr", "bin", name]);
        assert.equal(installed, sha256File(packed), `AppImage ${name} differs from its built AppDir`);
        if (installed !== staged) {
          // linuxdeploy can change RPATH. Bind the code to the verified input.
          const inputCode = readTextSection(original, directory, `${name}-staged`, run);
          const outputCode = readTextSection(payload[name], directory, `${name}-packed`, run);
          assert.equal(sha256File(inputCode), sha256File(outputCode), `AppImage ${name} code differs from the verified input`);
        }
      } else {
        assert.equal(installed, staged, `Installed ${name} differs from the verified input`);
      }
    }
    verifyBundledRuntime(payload.browser, browserRoot, target, browserLock);
    verifyFrontendDirectory(payload.frontend, frontendReceipt);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { verifyInstallerPayload };
