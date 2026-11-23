// Produce a component asset from the accepted native runtime. This command
// runs no compiler and does not reserve or publish a Bodhi installer version.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { installedRelease } = require("./bamboo-sidecar.cjs");
const { STAGED, sha256File, verifyRuntime } = require("./browser-runtime.cjs");

const ROOT = path.resolve(__dirname, "..");

function pack(target, destination) {
  const sidecar = installedRelease(ROOT, target, { BAMBOO_SIDECAR_SOURCE: "release", BAMBOO_SIDECAR_TARGET: target });
  verifyRuntime(STAGED, target, path.join(sidecar.hostDirectory, "browser-runtime"));
  const assetName = `bamboo-browser-runtime-v1-${target}.tar.gz`;
  const output = path.resolve(destination, assetName);
  const scratch = fs.mkdtempSync(path.join(path.resolve(destination), ".browser-asset-"));
  try {
    const temporary = path.join(scratch, assetName);
    execFileSync("tar", ["-czf", temporary, "-C", path.dirname(STAGED), path.basename(STAGED)], {
      env: { ...process.env, COPYFILE_DISABLE: "1" }, stdio: "pipe",
    });
    const sizeBytes = fs.statSync(temporary).size;
    if (sizeBytes <= 0 || sizeBytes > 768 * 1024 ** 2) throw new Error("Browser runtime archive exceeds its size limit");
    const artifact = {
      assetName,
      archive: { sha256: sha256File(temporary), sizeBytes },
      receiptSha256: sha256File(path.join(STAGED, "receipt.json")),
    };
    fs.copyFileSync(temporary, output, fs.constants.COPYFILE_EXCL);
    return { bambooVersion: sidecar.version, target, artifact };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const [target, directory] = process.argv.slice(2);
  try {
    if (!target || !directory) throw new Error("Usage: node scripts/pack-component-browser.cjs <target> <existing-output-directory>");
    console.log(JSON.stringify(pack(target, directory), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { pack };
