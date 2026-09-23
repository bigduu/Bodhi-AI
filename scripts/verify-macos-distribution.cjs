#!/usr/bin/env node
// Fail closed on the exact macOS assets that the release job is about to upload.
// Tauri signs/notarizes/staples; this independently checks its output.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ROOT } = require("./lotus-dist.cjs");
const { LOCK, machFiles, sha256File, verifyArchitecture, verifyRuntime } = require("./browser-runtime.cjs");

const BUNDLE_ID = "com.bodhi.app";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const message = (result.stderr || result.stdout || result.error?.message || "unknown error").trim();
    throw new Error(`${command} ${args[0] || ""} failed: ${message}`);
  }
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function oneEntry(directory, predicate, description) {
  const entries = fs.readdirSync(directory).filter(predicate);
  if (entries.length !== 1) {
    throw new Error(`Expected exactly one ${description} in ${directory}; found ${entries.length}.`);
  }
  return path.join(directory, entries[0]);
}

function parseCodesignDisplay(output, expectedTeam) {
  if (/^Signature=adhoc\s*$/m.test(output)) throw new Error("Ad-hoc signature is not distribution evidence.");
  const authority = output.match(/^Authority=(Developer ID Application: .+)\s*$/m)?.[1];
  const team = output.match(/^TeamIdentifier=([A-Z0-9]{10})\s*$/m)?.[1];
  const cdHash = output.match(/^CDHash=([a-fA-F0-9]{40})\s*$/m)?.[1]?.toLowerCase();
  if (!authority || team !== expectedTeam || !authority.endsWith(`(${expectedTeam})`) || !cdHash) {
    throw new Error("Code signature is not from the expected Developer ID Application team.");
  }
  if (!/^CodeDirectory .+flags=[^\n]*\(runtime\)/m.test(output)) {
    throw new Error("Code signature is missing the hardened runtime flag.");
  }
  if (!/^Timestamp=(?!none\s*$).+$/m.test(output)) {
    throw new Error("Code signature is missing an Apple timestamp.");
  }
  return { team, cdHash };
}

function inspectSignature(file, expectedTeam, expectedSignerSha) {
  run("codesign", ["--verify", "--strict", file]);
  const metadata = parseCodesignDisplay(run("codesign", ["--display", "--verbose=4", file]), expectedTeam);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-signature-cert-"));
  try {
    const prefix = path.join(directory, "certificate-");
    run("codesign", ["--display", `--extract-certificates=${prefix}`, file]);
    const leaf = fs.readFileSync(`${prefix}0`);
    const signerSha = crypto.createHash("sha1").update(leaf).digest("hex").toUpperCase();
    if (signerSha !== expectedSignerSha) {
      throw new Error(`The signed code does not use the configured Developer ID certificate: ${file}`);
    }
    return { ...metadata, signerSha };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function plistValue(app, name) {
  return run("plutil", ["-extract", name, "raw", "-o", "-", path.join(app, "Contents", "Info.plist")]).trim();
}

function verifyApp(app, target, expectedTeam, expectedSignerSha, expectedVersion) {
  assert.equal(plistValue(app, "CFBundleIdentifier"), BUNDLE_ID);
  const version = plistValue(app, "CFBundleShortVersionString");
  if (expectedVersion && version !== expectedVersion) {
    throw new Error(`The app version ${version} differs from the release candidate ${expectedVersion}.`);
  }
  const runtimePath = path.join(app, "Contents", "Resources", "BodhiBrowser");
  const browser = verifyRuntime(runtimePath, target);
  if (browser.signingIdentity !== expectedSignerSha ||
      browser.nodeVersion !== LOCK.nodeVersion || browser.chromiumVersion !== LOCK.chromiumVersion) {
    throw new Error("Bundled browser revision or signing identity differs from the release candidate.");
  }
  const sidecar = path.join(app, "Contents", "MacOS", "bamboo");
  const main = path.join(app, "Contents", "MacOS", "bodhi");
  verifyArchitecture(sidecar, target);
  verifyArchitecture(main, target);

  // Deep verification alone can miss code placed in an unusual Resources path.
  // Enumerate the actual nested Mach-O files in BodhiBrowser and check each leaf.
  const nested = [sidecar, main, ...machFiles(runtimePath)];
  for (const binary of nested) inspectSignature(binary, expectedTeam, expectedSignerSha);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const signature = inspectSignature(app, expectedTeam, expectedSignerSha);
  run("xcrun", ["stapler", "validate", "-v", app]);
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
  return {
    version,
    cdHash: signature.cdHash,
    browserFilesSha256: browser.filesSha256,
    browserHostSha256: browser.hostSha256,
    signedMachOCount: nested.length,
  };
}

function sameCandidate(actual, expected, source) {
  for (const field of ["version", "cdHash", "browserFilesSha256", "browserHostSha256", "signedMachOCount"]) {
    if (actual[field] !== expected[field]) throw new Error(`${source} does not contain the verified candidate app (${field}).`);
  }
}

function verifyDistribution(target, expectedTeam, expectedSignerSha, expectedVersion) {
  if (process.platform !== "darwin" || !["aarch64-apple-darwin", "x86_64-apple-darwin"].includes(target)) {
    throw new Error("Distribution verification requires a macOS release target and runner.");
  }
  if (!/^[A-Z0-9]{10}$/.test(expectedTeam) || !/^[A-F0-9]{40}$/.test(expectedSignerSha)) {
    throw new Error("The configured Developer ID team or certificate fingerprint is missing.");
  }

  const bundle = path.join(ROOT, "target", target, "release", "bundle");
  const macos = path.join(bundle, "macos");
  const app = oneEntry(macos, (name) => name.endsWith(".app") && fs.statSync(path.join(macos, name)).isDirectory(), ".app");
  const archive = oneEntry(macos, (name) => name.endsWith(".app.tar.gz"), ".app.tar.gz");
  const dmg = oneEntry(path.join(bundle, "dmg"), (name) => name.endsWith(".dmg"), ".dmg");
  const candidate = verifyApp(app, target, expectedTeam, expectedSignerSha, expectedVersion);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-distribution-check-"));
  const extracted = path.join(scratch, "archive");
  const mounted = path.join(scratch, "mounted-dmg");
  fs.mkdirSync(extracted);
  fs.mkdirSync(mounted);
  let attached = false;
  try {
    run("tar", ["-xzf", archive, "-C", extracted]);
    const archivedApp = oneEntry(extracted, (name) => name.endsWith(".app"), "archived .app");
    sameCandidate(verifyApp(archivedApp, target, expectedTeam, expectedSignerSha, expectedVersion), candidate, "The .app.tar.gz");

    run("xcrun", ["stapler", "validate", "-v", dmg]);
    run("hdiutil", ["attach", "-readonly", "-nobrowse", "-quiet", "-mountpoint", mounted, dmg]);
    attached = true;
    const dmgApp = oneEntry(mounted, (name) => name.endsWith(".app"), "DMG .app");
    sameCandidate(verifyApp(dmgApp, target, expectedTeam, expectedSignerSha, expectedVersion), candidate, "The DMG");
  } finally {
    if (attached) run("hdiutil", ["detach", "-quiet", mounted]);
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const receipt = {
    schemaVersion: 1,
    target,
    bodhiCommit: run("git", ["-C", ROOT, "rev-parse", "HEAD"]).trim(),
    bambooCommit: run("git", ["-C", path.join(ROOT, "bamboo-src"), "rev-parse", "HEAD"]).trim(),
    bundleId: BUNDLE_ID,
    appVersion: candidate.version,
    signingTeam: expectedTeam,
    signingCertificateSha1: expectedSignerSha,
    appCdHash: candidate.cdHash,
    signedMachOCount: candidate.signedMachOCount,
    nodeVersion: LOCK.nodeVersion,
    playwrightCoreVersion: LOCK.playwrightCoreVersion,
    chromiumVersion: LOCK.chromiumVersion,
    chromiumRevision: LOCK.chromiumRevision,
    browserFilesSha256: candidate.browserFilesSha256,
    browserHostSha256: candidate.browserHostSha256,
    appArchiveSha256: sha256File(archive),
    dmgSha256: sha256File(dmg),
    verified: {
      app: "Developer ID, hardened runtime, timestamp, stapled, Gatekeeper accepted",
      appArchive: "same signed and stapled app",
      dmg: "stapled with the same signed app",
    },
  };
  const output = path.join(macos, `bodhi-${target}-distribution-receipt.json`);
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`Verified notarized ${target} candidate; app CDHash ${candidate.cdHash}; receipt ${output}`);
  return output;
}

module.exports = { inspectSignature, oneEntry, parseCodesignDisplay, sameCandidate, verifyDistribution };

if (require.main === module) {
  try {
    verifyDistribution(process.argv[2], process.env.BODHI_SIGNING_TEAM, process.env.APPLE_SIGNING_IDENTITY, process.env.BODHI_RELEASE_VERSION);
  } catch (error) {
    console.error(`Distribution: ${error.message}`);
    process.exitCode = 1;
  }
}
