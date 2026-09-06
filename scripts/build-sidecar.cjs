#!/usr/bin/env node
/**
 * Build the bamboo HTTP-server binary that the Bodhi shell runs as a Tauri
 * sidecar, and place it at `src-tauri/binaries/bamboo-<target-triple>`.
 *
 *   profile: --release (default) | --debug
 *   source : BAMBOO_SIDECAR_SOURCE = local (default when ../bamboo exists) | none
 *
 * Local source builds stage verified Lotus Next resources and compile an API-only
 * sidecar. Explicit package releases retain Bamboo's existing embedded frontend
 * until Zenith #187 completes the formal release consumer cutover.
 *
 * NOTE: `cargo build` on its own does NOT run this — Tauri's `build.rs` writes a
 * placeholder so the `externalBin` reference resolves (keeps a bare shell-compile,
 * e.g. CI, green). This script produces the *real* binary for `tauri build` / dev
 * and the zenith superproject release.
 */
const { execFileSync } = require("node:child_process");
const fs = require("fs");
const path = require("path");
const { resolveSource } = require("./lotus-dist.cjs");
const { buildFrontend } = require("./web-build.cjs");

const BODHI = path.resolve(__dirname, "..");
const BAMBOO = path.resolve(BODHI, process.env.BAMBOO_LOCAL_PATH || "../bamboo");
const isDebug = process.argv.includes("--debug");
const profile = isDebug ? "debug" : "release";

const frontend = resolveSource();
buildFrontend(frontend);
const buildEnv = {
  ...process.env,
  BAMBOO_FRONTEND_BUILD_MODE: frontend.mode === "local" ? "api-only" : "embedded",
};
const run = (command, args, cwd) => execFileSync(command, args, { cwd, env: buildEnv, stdio: "inherit" });

function hostTriple() {
  const m = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/host:\s*(\S+)/);
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
  if (frontend.mode === "local") {
    throw new Error(`Local Bodhi needs a real Bamboo checkout at ${BAMBOO}. Set BAMBOO_LOCAL_PATH and rerun; a placeholder cannot serve Lotus Next.`);
  }
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

if (frontend.mode === "package" && !isDebug) {
  console.log("🔧 Building the embedded lotus frontend for the sidecar (production)…");
  // Published Bamboo main and dev currently use these two producer layouts.
  // Observe which complete pair was actually regenerated, without deleting
  // existing files or letting stale root output overwrite a fresh crate output.
  const names = ["lotus-frontend.zip", "frontend-manifest.json"];
  const rootPkg = path.join(BAMBOO, "frontend_package");
  const serverPkg = path.join(BAMBOO, "crates", "app", "bamboo-server", "frontend_package");
  const layouts = [rootPkg, serverPkg];
  const stamps = (dir) => {
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Frontend package directory is a symlink: ${dir}. Set BAMBOO_LOCAL_PATH to a clean checkout; the existing link was left untouched.`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return names.map((name) => {
    try {
      const stat = fs.lstatSync(path.join(dir, name), { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid frontend package file: ${path.join(dir, name)}`);
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    });
  };
  const before = layouts.map(stamps);
  run(process.execPath, ["scripts/frontend-package.cjs"], BAMBOO);
  const after = layouts.map(stamps);
  const changed = layouts.map((_, index) => index).filter((index) => after[index].some((stamp, file) => stamp !== before[index][file]));
  if (changed.length !== 1 || after[changed[0]].some((stamp, file) => stamp === null || stamp === before[changed[0]][file])) {
    throw new Error("Explicit package assembly must generate one fresh, complete zip/manifest pair; stale, partial or ambiguous outputs are refused.");
  }
  if (changed[0] === 0) {
    fs.mkdirSync(serverPkg, { recursive: true });
    for (const name of names) fs.copyFileSync(path.join(rootPkg, name), path.join(serverPkg, name));
    console.log("✅ Mirrored fresh workspace-root frontend pair into bamboo-server");
  }
}

console.log(
  `🔧 Building bamboo sidecar (${profile}${isCross ? `, cross → ${triple}` : ""}) from ${BAMBOO} …`,
);
run("cargo", ["build", "--locked", "--bin", "bamboo", ...(isDebug ? [] : ["--release"]), ...(isCross ? ["--target", triple] : [])], BAMBOO);

// Cross builds land under target/<triple>/<profile>; host builds under target/<profile>.
const targetDir = path.resolve(BAMBOO, process.env.CARGO_TARGET_DIR || "target");
const built = isCross
  ? path.join(targetDir, triple, profile, `bamboo${ext}`)
  : path.join(targetDir, profile, `bamboo${ext}`);
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
