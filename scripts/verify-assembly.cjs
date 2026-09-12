const fs = require("node:fs");
const path = require("node:path");
const { ROOT, verifyStaged } = require("./lotus-dist.cjs");

function verifySidecar(root, target) {
  if (
    typeof target !== "string" ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(target)
  ) {
    throw new Error(`Invalid sidecar target triple: ${JSON.stringify(target)}`);
  }
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
  const header = Buffer.alloc(4);
  try {
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      throw new Error(`Cannot read the sidecar header at ${binary}.`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  const hex = header.toString("hex");
  const valid = target.includes("windows")
    ? header.subarray(0, 2).toString("ascii") === "MZ"
    : target.includes("linux")
      ? hex === "7f454c46"
      : target.includes("darwin")
        ? ["cffaedfe", "feedfacf", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(hex)
        : false;
  if (!valid) {
    throw new Error(`Sidecar ${binary} does not match target ${target}.`);
  }
  return { binary, size: metadata.size };
}

module.exports = { verifySidecar };

if (require.main === module) {
  try {
    const target = process.argv[2] || process.env.BAMBOO_SIDECAR_TARGET;
    const receipt = verifyStaged();
    const sidecar = verifySidecar(ROOT, target);
    console.log(
      `Verified ${receipt.packageName}@${receipt.version} and real ${target} sidecar (${sidecar.size} bytes).`,
    );
  } catch (error) {
    console.error(`Assembly: ${error.message}`);
    process.exitCode = 1;
  }
}
