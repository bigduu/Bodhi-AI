#!/usr/bin/env node
// Bodhi's local source boundary. Published-package assembly stays explicit until
// Zenith #187 completes the formal consumer cutover.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const NEXT_PACKAGE = "@bigduu/lotus-next";
const LEGACY_PACKAGE = "@bigduu/lotus";
const RECEIPT = "receipt.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

function resolveSource(env = process.env, root = ROOT) {
  const mode = (env.LOTUS_SOURCE || "local").toLowerCase();
  if (!["local", "package"].includes(mode)) {
    throw new Error(`Invalid LOTUS_SOURCE=${mode}. Use local (default) or explicit package; automatic fallback was removed.`);
  }
  let sourceRoot;
  let packageName;
  if (mode === "local") {
    packageName = NEXT_PACKAGE;
    if (env.LOTUS_PACKAGE_NAME && env.LOTUS_PACKAGE_NAME !== packageName) {
      throw new Error(`Local builds require ${packageName}; remove LOTUS_PACKAGE_NAME=${env.LOTUS_PACKAGE_NAME}.`);
    }
    sourceRoot = path.resolve(root, env.LOTUS_LOCAL_PATH || "../lotus-next");
    if (!fs.existsSync(path.join(sourceRoot, "package.json"))) {
      throw new Error(`Lotus Next is missing at ${sourceRoot}. Check out sibling ../lotus-next or set LOTUS_LOCAL_PATH to its checkout.`);
    }
  } else {
    packageName = env.LOTUS_PACKAGE_NAME;
    if (packageName !== LEGACY_PACKAGE) {
      throw new Error(`The temporary release path requires explicit LOTUS_SOURCE=package LOTUS_PACKAGE_NAME=${LEGACY_PACKAGE}. Lotus Next package cutover belongs to Zenith #187.`);
    }
    try {
      sourceRoot = path.dirname(require.resolve(`${packageName}/package.json`, { paths: [root] }));
    } catch {
      throw new Error(`Explicit release package ${packageName} is not installed. Install the selected release version in Bodhi.`);
    }
  }
  const pkg = readJson(path.join(sourceRoot, "package.json"));
  if (pkg.name !== packageName || typeof pkg.version !== "string" || !pkg.version) {
    throw new Error(`Frontend identity mismatch at ${sourceRoot}: expected ${packageName} with a version.`);
  }
  return { mode, sourceRoot, packageName, version: pkg.version };
}

function sourceIdentity(source) {
  if (source.mode === "package") return { sourceRevision: null, sourceDirty: false };
  const git = (...args) => execFileSync("git", ["-C", source.sourceRoot, ...args], { encoding: "utf8" }).trim();
  const sourceRevision = git("rev-parse", "HEAD");
  if (!/^[a-f0-9]{40}$/.test(sourceRevision) || fs.realpathSync(git("rev-parse", "--show-toplevel")) !== fs.realpathSync(source.sourceRoot)) {
    throw new Error("LOTUS_LOCAL_PATH must identify the Lotus Next Git checkout root.");
  }
  return { sourceRevision, sourceDirty: git("status", "--porcelain", "--untracked-files=normal") !== "" };
}

function localBuildEnvironment(source, env = process.env, identity = sourceIdentity(source)) {
  if ((env.VITE_BACKEND_BASE_URL || "").trim()) {
    throw new Error("Bodhi local artifacts require runtime backend discovery. Unset VITE_BACKEND_BASE_URL; use BODHI_BACKEND_PORT when launching the app.");
  }
  return {
    ...env,
    // Explicitly override .env files too. Lotus Next's public-variable schema
    // still rejects every other unexpected VITE_* input during its own build.
    VITE_BACKEND_BASE_URL: "",
    VITE_APP_REVISION: identity.sourceRevision,
    VITE_APP_VERSION: source.version,
  };
}

function safeRelative(file) {
  return typeof file === "string" && file.length > 0 &&
    !/[\\:\x00-\x1f\x7f]/.test(file) &&
    file.split("/").every((part) => part && part !== "." && part !== "..");
}

function inventory(dist) {
  const files = {};
  function visit(dir, prefix = "") {
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Frontend symlink is not allowed: ${dir}`);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      const target = path.join(dir, entry.name);
      if (!safeRelative(name) || entry.isSymbolicLink()) throw new Error(`Unsafe frontend path: ${name}`);
      if (entry.isDirectory()) visit(target, `${name}/`);
      else if (entry.isFile()) files[name] = sha256(fs.readFileSync(target));
      else throw new Error(`Frontend resource is not a regular file: ${name}`);
    }
  }
  visit(dist);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
}

function contentHash(files) {
  // Object enumeration reorders integer-like keys even after fromEntries was
  // sorted. Sort here too, matching Rust's BTreeMap UTF-8 filename ordering.
  return sha256(Object.entries(files)
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(([name, hash]) => `${name}\0${hash}\n`).join(""));
}

// Read actual opening tags. Inline diagnostics can contain strings such as
// 'href=" + location.href'; those are JavaScript text, never asset references.
function openingTags(html) {
  const tags = [];
  const token = /<!--[\s\S]*?(?:-->|$)|<([a-z][\w:-]*)\b((?:"[^"]*"|'[^']*'|[^'"<>])*)>/gi;
  let match;
  while ((match = token.exec(html))) {
    if (!match[1]) continue;
    const name = match[1].toLowerCase();
    const attrs = Object.create(null);
    for (const attr of match[2].matchAll(/(?:^|\s)([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
      const key = attr[1].toLowerCase();
      if (!Object.hasOwn(attrs, key)) attrs[key] = attr[2] ?? attr[3] ?? attr[4];
    }
    tags.push({ name, attrs });
    if (["script", "style", "textarea", "title"].includes(name)) {
      const closing = new RegExp(`</${name}\\s*>`, "gi");
      closing.lastIndex = token.lastIndex;
      token.lastIndex = closing.exec(html) ? closing.lastIndex : html.length;
    }
  }
  return tags;
}

function verifyDist(source, dist = path.join(source.sourceRoot, "dist")) {
  const files = inventory(dist);
  const required = (name) => {
    if (!safeRelative(name) || !Object.hasOwn(files, name)) throw new Error(`Missing or invalid frontend asset: ${name}`);
  };
  required("index.html");
  const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
  const tags = openingTags(html);
  const modules = tags.filter((tag) => tag.name === "script" && tag.attrs.type?.toLowerCase() === "module" && tag.attrs.src);
  if (modules.length === 0 || modules.some(({ attrs }) => /@vite\/client|^(?:\.\/|\/)?src\/|\.tsx?(?:$|[?#])/i.test(attrs.src))) {
    throw new Error("Frontend index.html must reference a built production module, not a Vite development entry.");
  }
  for (const tag of tags) {
    const reference = tag.name === "link" ? tag.attrs.href : tag.attrs.src;
    if (!reference || (tag.name !== "script" && /^(?:data:|#)/.test(reference))) continue;
    if (/^(?:[a-z]+:|\/\/)/i.test(reference)) throw new Error("Frontend entry assets must be packaged locally.");
    const decoded = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
    required(decoded.replace(/^(?:\.\/|\/)/, ""));
  }
  if (source.mode === "local") {
    required("asset-manifest.json");
    const manifest = readJson(path.join(dist, "asset-manifest.json"));
    if (!manifest["index.html"]?.isEntry) throw new Error("Frontend asset manifest has no production index entry.");
    for (const record of Object.values(manifest)) {
      required(record.file);
      for (const key of ["css", "assets"]) {
        if (record[key] !== undefined && !Array.isArray(record[key])) throw new Error(`Invalid asset manifest ${key}.`);
        for (const file of record[key] || []) required(file);
      }
      for (const key of ["imports", "dynamicImports"]) {
        if (record[key] !== undefined && !Array.isArray(record[key])) throw new Error(`Invalid asset manifest ${key}.`);
        for (const imported of record[key] || []) {
          if (typeof imported !== "string" || !Object.hasOwn(manifest, imported)) throw new Error(`Missing asset manifest import: ${imported}`);
        }
      }
    }
  }
  return files;
}

function stageDist(source, root = ROOT, identity = sourceIdentity(source)) {
  const dist = path.join(source.sourceRoot, "dist");
  const files = verifyDist(source, dist);
  const receipt = {
    schemaVersion: 1,
    mode: source.mode,
    packageName: source.packageName,
    version: source.version,
    ...identity,
    contentHash: contentHash(files),
    files,
  };
  const output = path.join(root, ".lotus-dist");
  const resource = path.join(root, ".bodhi-frontend");
  // Only generated outputs are replaced. Verification failure exits the build
  // before Tauri packaging, without minting a new receipt.
  for (const target of [output, resource]) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
  }
  fs.cpSync(dist, output, { recursive: true });
  if (source.mode === "local") fs.cpSync(dist, path.join(resource, "dist"), { recursive: true });
  fs.writeFileSync(path.join(resource, RECEIPT), `${JSON.stringify(receipt)}\n`);
  console.log(`Verified ${source.packageName} ${receipt.sourceRevision || source.version}${receipt.sourceDirty ? " (dirty source)" : ""}: sha256 ${receipt.contentHash}`);
  return receipt;
}

module.exports = { ROOT, NEXT_PACKAGE, LEGACY_PACKAGE, RECEIPT, resolveSource, sourceIdentity, localBuildEnvironment, safeRelative, inventory, contentHash, verifyDist, stageDist };

if (require.main === module) {
  try {
    const command = process.argv[2] || "stage";
    if (command === "info") console.log(JSON.stringify(resolveSource(), null, 2));
    else if (command === "stage") require("./web-build.cjs").buildFrontend();
    else throw new Error(`Unknown command ${command}; use stage or info.`);
  } catch (error) {
    console.error(`Frontend: ${error.message}`);
    process.exitCode = 1;
  }
}
