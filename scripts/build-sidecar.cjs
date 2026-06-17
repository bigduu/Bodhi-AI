#!/usr/bin/env node
/**
 * Build the bamboo HTTP-server binary that the Bodhi shell runs as a Tauri
 * sidecar, and place it at `src-tauri/binaries/bamboo-<target-triple>`.
 *
 *   profile: --release (default) | --debug
 *   source : BAMBOO_SIDECAR_SOURCE = local (default when ../bamboo exists) | none
 *
 * For a release build it first (re)builds the embedded lotus frontend via bamboo's
 * own `frontend-package.cjs` (which honors LOTUS_SOURCE) so the sidecar serves a
 * fresh production lotus; a debug build reuses the existing embed, since `tauri dev`
 * uses lotus's own HMR dev server for the UI.
 *
 * NOTE: `cargo build` on its own does NOT run this — Tauri's `build.rs` writes a
 * placeholder so the `externalBin` reference resolves (keeps a bare shell-compile,
 * e.g. CI, green). This script produces the *real* binary for `tauri build` / dev
 * and the zenith superproject release.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const BODHI = path.resolve(__dirname, "..");
const BAMBOO = path.resolve(BODHI, process.env.BAMBOO_LOCAL_PATH || "../bamboo");
const isDebug = process.argv.includes("--debug");
const profile = isDebug ? "debug" : "release";

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit" });

function hostTriple() {
  const m = execSync("rustc -vV", { encoding: "utf8" }).match(/host:\s*(\S+)/);
  if (!m) throw new Error("cannot determine host target triple from `rustc -vV`");
  return m[1];
}
const bambooExists = () => {
  try {
    return fs.statSync(path.join(BAMBOO, "Cargo.toml")).isFile();
  } catch {
    return false;
  }
};

const SOURCE = (
  process.env.BAMBOO_SIDECAR_SOURCE || (bambooExists() ? "local" : "none")
).toLowerCase();
// Target triple for the sidecar. Defaults to the build host, but CI cross-builds
// (e.g. an x86_64 app on an arm64 macOS runner) set BAMBOO_SIDECAR_TARGET to the
// matrix target so the sidecar's architecture matches the app and Tauri's
// `externalBin` lookup (`bamboo-<target-triple>`) resolves to a real binary
// instead of falling back to the build.rs placeholder.
const host = hostTriple();
const triple = (process.env.BAMBOO_SIDECAR_TARGET || "").trim() || host;
const isCross = triple !== host;
const isWin = triple.includes("windows");
const ext = isWin ? ".exe" : "";
const binDir = path.join(BODHI, "src-tauri", "binaries");
fs.mkdirSync(binDir, { recursive: true });
const dest = path.join(binDir, `bamboo-${triple}${ext}`);

if (SOURCE !== "local") {
  console.log(
    `ℹ️  BAMBOO_SIDECAR_SOURCE=${SOURCE}: no local ../bamboo checkout; keeping the build.rs ` +
      `placeholder (the real sidecar is assembled in the zenith superproject).`,
  );
  process.exit(0);
}
if (!bambooExists()) {
  console.error(`❌ BAMBOO_SIDECAR_SOURCE=local but bamboo not found at ${BAMBOO}`);
  process.exit(1);
}

if (!isDebug) {
  console.log("🔧 Building the embedded lotus frontend for the sidecar (production)…");
  sh("node scripts/frontend-package.cjs", BAMBOO);

  // frontend-package.cjs stages the package at the bamboo workspace ROOT
  // (frontend_package/), but bamboo-server's build.rs embeds it from ITS OWN
  // crate dir (CARGO_MANIFEST_DIR/frontend_package) via include_bytes!. Since the
  // crates were reorganized under crates/app/, those paths no longer line up, so
  // the embed silently resolves to None and the sidecar compiles as an API-only
  // server with no UI — the webview then navigates to a 404 and the app hangs on
  // the "Starting Bodhi…" splash. Mirror the staged package into the crate dir so
  // the compile-time embed actually picks it up.
  const stagedPkg = path.join(BAMBOO, "frontend_package");
  const serverPkg = path.join(BAMBOO, "crates", "app", "bamboo-server", "frontend_package");
  if (fs.existsSync(path.join(stagedPkg, "lotus-frontend.zip"))) {
    fs.rmSync(serverPkg, { recursive: true, force: true });
    fs.cpSync(stagedPkg, serverPkg, { recursive: true });
    console.log(`✅ mirrored frontend package → ${path.relative(BAMBOO, serverPkg)}`);
  } else {
    console.warn(
      `⚠️  no staged frontend package at ${stagedPkg}; sidecar will be API-only (no UI)`,
    );
  }
}

const targetFlag = isCross ? ` --target ${triple}` : "";
console.log(
  `🔧 Building bamboo sidecar (${profile}${isCross ? `, cross → ${triple}` : ""}) from ${BAMBOO} …`,
);
sh(`cargo build --bin bamboo${isDebug ? "" : " --release"}${targetFlag}`, BAMBOO);

// Cross builds land under target/<triple>/<profile>; host builds under target/<profile>.
const built = isCross
  ? path.join(BAMBOO, "target", triple, profile, `bamboo${ext}`)
  : path.join(BAMBOO, "target", profile, `bamboo${ext}`);
fs.copyFileSync(built, dest);
if (!isWin) fs.chmodSync(dest, 0o755);

// Dev convenience: Tauri caches the sidecar under the no-triple name next to the
// dev executable and reuses it; overwrite it so dev runs pick up the fresh build.
const devCache = path.join(BODHI, "target", profile, `bamboo${ext}`);
try {
  fs.mkdirSync(path.dirname(devCache), { recursive: true });
  fs.copyFileSync(built, devCache);
  if (!isWin) fs.chmodSync(devCache, 0o755);
} catch {
  /* best-effort */
}

console.log(`✅ sidecar -> ${path.relative(BODHI, dest)}`);
