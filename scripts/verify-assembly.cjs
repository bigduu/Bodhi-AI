const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const { ROOT, NEXT_PACKAGE, contentHash, inventory, verifyStaged } = require("./lotus-dist.cjs");

function readExact(descriptor, length, position, binary) {
  const buffer = Buffer.alloc(length);
  if (fs.readSync(descriptor, buffer, 0, length, position) !== length) {
    throw new Error(`Cannot read the executable header at ${binary}.`);
  }
  return buffer;
}

function expectedArchitecture(target) {
  if (target.startsWith("x86_64-")) {
    return { name: "x86_64", elf: 0x3e, mach: 0x01000007, pe: 0x8664 };
  }
  if (target.startsWith("aarch64-")) {
    return { name: "aarch64", elf: 0xb7, mach: 0x0100000c, pe: 0xaa64 };
  }
  throw new Error(`Unsupported sidecar CPU architecture in target ${target}.`);
}

function machCpuTypes(descriptor, binary, size) {
  const header = readExact(descriptor, 8, 0, binary);
  const magic = header.subarray(0, 4).toString("hex");
  if (magic === "cffaedfe") return [header.readUInt32LE(4)];
  if (magic === "feedfacf") return [header.readUInt32BE(4)];

  const fatFormats = {
    cafebabe: { littleEndian: false, entrySize: 20 },
    bebafeca: { littleEndian: true, entrySize: 20 },
    cafebabf: { littleEndian: false, entrySize: 32 },
    bfbafeca: { littleEndian: true, entrySize: 32 },
  };
  const format = fatFormats[magic];
  if (!format) throw new Error(`Sidecar ${binary} is not a 64-bit Mach-O executable.`);
  const readU32 = (buffer, offset) =>
    format.littleEndian
      ? buffer.readUInt32LE(offset)
      : buffer.readUInt32BE(offset);
  const count = readU32(header, 4);
  if (count === 0 || count > 64 || 8 + count * format.entrySize > size) {
    throw new Error(`Sidecar ${binary} has an invalid Mach-O architecture table.`);
  }
  const cpuTypes = [];
  for (let index = 0; index < count; index += 1) {
    const entry = readExact(
      descriptor,
      format.entrySize,
      8 + index * format.entrySize,
      binary,
    );
    cpuTypes.push(readU32(entry, 0));
  }
  return cpuTypes;
}

function elfCpuType(descriptor, binary) {
  const header = readExact(descriptor, 20, 0, binary);
  if (header.subarray(0, 4).toString("hex") !== "7f454c46") {
    throw new Error(`Sidecar ${binary} is not an ELF executable.`);
  }
  if (header[4] !== 2 || ![1, 2].includes(header[5])) {
    throw new Error(`Sidecar ${binary} is not a supported 64-bit ELF executable.`);
  }
  return header[5] === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18);
}

function peCpuType(descriptor, binary, size) {
  const dos = readExact(descriptor, 64, 0, binary);
  if (dos.subarray(0, 2).toString("ascii") !== "MZ") {
    throw new Error(`Sidecar ${binary} is not a PE executable.`);
  }
  const peOffset = dos.readUInt32LE(0x3c);
  if (peOffset > size - 6) {
    throw new Error(`Sidecar ${binary} has an invalid PE header offset.`);
  }
  const coff = readExact(descriptor, 6, peOffset, binary);
  if (coff.subarray(0, 4).toString("hex") !== "50450000") {
    throw new Error(`Sidecar ${binary} has an invalid PE signature.`);
  }
  return coff.readUInt16LE(4);
}

function verifySidecar(root, target) {
  if (
    typeof target !== "string" ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(target)
  ) {
    throw new Error(`Invalid sidecar target triple: ${JSON.stringify(target)}`);
  }
  const expected = expectedArchitecture(target);
  const extension = target.includes("windows") ? ".exe" : "";
  const binary = path.join(
    root,
    "src-tauri",
    "binaries",
    `bamboo-${target}${extension}`,
  );
  const metadata = fs.lstatSync(binary);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size < 65536) {
    throw new Error(
      `Sidecar ${binary} is missing, linked, or still a build-script placeholder.`,
    );
  }
  const descriptor = fs.openSync(binary, "r");
  let actual;
  try {
    actual = target.includes("windows")
      ? peCpuType(descriptor, binary, metadata.size)
      : target.includes("linux")
        ? elfCpuType(descriptor, binary)
        : target.includes("darwin")
          ? machCpuTypes(descriptor, binary, metadata.size)
          : null;
  } finally {
    fs.closeSync(descriptor);
  }
  const matches = Array.isArray(actual)
    ? actual.includes(expected.mach)
    : actual === (target.includes("windows") ? expected.pe : expected.elf);
  if (!matches) {
    throw new Error(
      `Sidecar ${binary} does not contain the ${expected.name} CPU architecture required by ${target}.`,
    );
  }
  return { binary, size: metadata.size, architecture: expected.name };
}

function verifyBundledFrontend(app, expected) {
  const frontend = path.join(app, "Contents", "Resources", "frontend");
  const directory = fs.lstatSync(frontend);
  const receiptPath = path.join(frontend, "receipt.json");
  const receiptFile = fs.lstatSync(receiptPath);
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      !receiptFile.isFile() || receiptFile.isSymbolicLink()) {
    throw new Error("The bundled frontend must be an owned directory with a regular receipt.");
  }
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  if (!isDeepStrictEqual(receipt, expected)) {
    throw new Error("The app bundle contains a different Lotus frontend receipt.");
  }
  const dist = path.join(frontend, "dist");
  if (expected.packageName === NEXT_PACKAGE) {
    const files = inventory(dist);
    if (contentHash(files) !== expected.contentHash || !isDeepStrictEqual(files, expected.files)) {
      throw new Error("The app bundle contains different Lotus frontend assets.");
    }
  } else if (fs.existsSync(dist)) {
    throw new Error("The legacy rollback bundle must not carry a second Tauri frontend.");
  }
}

function verifyBundledRuntime(runtime, staged, target) {
  const { verifyRuntime } = require("./browser-runtime.cjs");
  verifyRuntime(staged, target);
  const bundled = verifyRuntime(runtime, target);
  // Bind the complete receipt, including the host/package lock and signing
  // identity, to the selected build instead of accepting any valid old runtime.
  if (!fs.readFileSync(path.join(runtime, "receipt.json"))
      .equals(fs.readFileSync(path.join(staged, "receipt.json")))) {
    throw new Error("The app bundle does not contain the exact staged browser runtime.");
  }
  return bundled;
}

function verifyMacosBundle(root, target, receipt, appPath) {
  const app = appPath
    ? path.resolve(appPath)
    : path.join(root, "target", target, "release", "bundle", "macos", "Bodhi AI.app");
  const metadata = fs.lstatSync(app);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The macOS app bundle must be an owned directory.");
  }
  verifyBundledFrontend(app, receipt);
  const browser = verifyBundledRuntime(
    path.join(app, "Contents", "Resources", "browser-runtime"),
    path.join(root, "src-tauri", "browser-runtime"), target,
  );
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" });
  return browser;
}

module.exports = { verifySidecar, expectedArchitecture, elfCpuType, peCpuType, verifyBundledFrontend, verifyBundledRuntime, verifyMacosBundle };

if (require.main === module) {
  try {
    const target = process.argv[2] || process.env.BAMBOO_SIDECAR_TARGET;
    const receipt = verifyStaged();
    const sidecar = verifySidecar(ROOT, target);
    if (process.env.BAMBOO_SIDECAR_SOURCE === "release") {
      require("./bamboo-sidecar.cjs").installedRelease(ROOT, target);
    }
    if (target.endsWith("-apple-darwin")) {
      verifyMacosBundle(ROOT, target, receipt, process.argv[3]);
    } else {
      require("./browser-runtime.cjs").verifyRuntime(path.join(ROOT, "src-tauri/browser-runtime"), target);
    }
    console.log(
      `Verified ${receipt.packageName}@${receipt.version} and real ${target} ${sidecar.architecture} sidecar (${sidecar.size} bytes).`,
    );
  } catch (error) {
    console.error(`Assembly: ${error.message}`);
    process.exitCode = 1;
  }
}
