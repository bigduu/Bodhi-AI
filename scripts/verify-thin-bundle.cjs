const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { sha256File, verifyArchitecture } = require("./browser-runtime.cjs");

function requireShellOnly(root) {
  const metadata = fs.lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Expected a regular installer payload directory");
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (/^(?:bamboo(?:-[^.]+)?(?:\.exe)?|browser-runtime|frontend|node_modules|chromium|lotus-next-manifest\.json|node(?:\.exe)?|chrome-headless-shell(?:\.exe)?)$/i.test(entry.name)) {
      throw new Error(`Thin Bodhi installer contains a component: ${entry.name}`);
    }
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) requireShellOnly(path.join(root, entry.name));
  }
}

function verifyMacos(appPath, version) {
  requireShellOnly(appPath);
  const contents = path.join(appPath, "Contents");
  const shell = path.join(contents, "MacOS", "bodhi");
  if (!fs.lstatSync(shell).isFile()) throw new Error("The native shell is missing from the thin app");
  verifyArchitecture(shell, "aarch64-apple-darwin");
  const actual = execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", path.join(contents, "Info.plist")], { encoding: "utf8" }).trim();
  if (actual !== version) throw new Error(`Bodhi bundle version ${actual} differs from ${version}`);
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "pipe" });
  return { version: actual, target: "aarch64-apple-darwin", shellBytes: fs.statSync(shell).size };
}

function verifyMacosDmg(image, stagedApp, version, env) {
  const mount = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "bodhi-thin-image-"));
  const run = (args) => execFileSync("hdiutil", args, { env, stdio: "pipe", timeout: 120_000 });
  let attached = false;
  try {
    run(["attach", image, "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount]);
    attached = true;
    const app = path.join(mount, "Bodhi AI.app");
    verifyMacos(app, version);
    const shell = "Contents/MacOS/bodhi";
    if (sha256File(path.join(app, shell)) !== sha256File(path.join(stagedApp, shell))) {
      throw new Error("The DMG shell differs from the verified app");
    }
  } finally {
    if (attached) run(["detach", mount]);
    fs.rmdirSync(mount);
  }
}

if (require.main === module) {
  try {
    const [appPath, version] = process.argv.slice(2);
    if (!appPath || !version) throw new Error("Usage: node scripts/verify-thin-bundle.cjs <app-path> <version>");
    console.log(JSON.stringify(verifyMacos(path.resolve(appPath), version)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { requireShellOnly, verifyMacos, verifyMacosDmg };
