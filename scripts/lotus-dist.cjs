#!/usr/bin/env node
// Bodhi's verified local and published-package frontend boundary.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const {
  ARTIFACT_MANIFEST_FILE,
  readArtifactLock,
  verifyLotusNextArtifact,
} = require("./lotus-next-artifact.cjs");

const ROOT = path.resolve(__dirname, "..");
const NEXT_PACKAGE = "@bigduu/lotus-next";
const LEGACY_PACKAGE = "@bigduu/lotus";
const RECEIPT = "receipt.json";
const RECEIPT_SCHEMA_VERSION = 2;
const ARTIFACT_LOCK = "frontend-package-lock.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function readJson(file) {
  try {
    const metadata = fs.lstatSync(file);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("expected a regular file, not a symbolic link");
    }
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
    packageName = env.LOTUS_PACKAGE_NAME || NEXT_PACKAGE;
    if (![NEXT_PACKAGE, LEGACY_PACKAGE].includes(packageName)) {
      throw new Error(
        `Package builds require ${NEXT_PACKAGE} (default) or the explicit rollback ${LEGACY_PACKAGE}; received ${packageName}.`,
      );
    }
    try {
      sourceRoot = path.dirname(require.resolve(`${packageName}/package.json`, { paths: [root] }));
    } catch {
      throw new Error(`Frontend package ${packageName} is not installed. Install the selected exact version in Bodhi.`);
    }
  }
  const pkg = readJson(path.join(sourceRoot, "package.json"));
  if (pkg.name !== packageName || typeof pkg.version !== "string" || !pkg.version) {
    throw new Error(`Frontend identity mismatch at ${sourceRoot}: expected ${packageName} with a version.`);
  }
  const artifactLock = mode === "package" && packageName === NEXT_PACKAGE
    ? readArtifactLock(path.join(root, "scripts", ARTIFACT_LOCK))
    : null;
  if (artifactLock && pkg.version !== artifactLock.packageVersion) {
    throw new Error(
      `Installed ${packageName}@${pkg.version} does not match the locked ${artifactLock.packageVersion}.`,
    );
  }
  return { mode, sourceRoot, packageName, version: pkg.version, artifactLock };
}

function sourceIdentity(source) {
  if (source.mode === "package") {
    if (source.packageName === NEXT_PACKAGE) {
      const { manifest, manifestSha256 } = verifyLotusNextArtifact({
        distDirectory: path.join(source.sourceRoot, "dist"),
        expectedIdentity: source.artifactLock,
      });
      if (source.version !== manifest.packageVersion) {
        throw new Error(
          `Package metadata ${source.version} does not match universal manifest ${manifest.packageVersion}.`,
        );
      }
      return {
        sourceRevision: manifest.sourceRevision,
        sourceDirty: manifest.sourceDirty,
        artifactManifestSha256: manifestSha256,
        artifactResourcesSha256: manifest.resourcesSha256,
      };
    }
    return {
      sourceRevision: null,
      sourceDirty: false,
      artifactManifestSha256: null,
      artifactResourcesSha256: null,
    };
  }
  const git = (...args) => execFileSync("git", ["-C", source.sourceRoot, ...args], { encoding: "utf8" }).trim();
  const sourceRevision = git("rev-parse", "HEAD");
  if (!/^[a-f0-9]{40}$/.test(sourceRevision) || fs.realpathSync(git("rev-parse", "--show-toplevel")) !== fs.realpathSync(source.sourceRoot)) {
    throw new Error("LOTUS_LOCAL_PATH must identify the Lotus Next Git checkout root.");
  }
  return {
    sourceRevision,
    sourceDirty: git("status", "--porcelain", "--untracked-files=normal") !== "",
    artifactManifestSha256: null,
    artifactResourcesSha256: null,
  };
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
  } else if (source.packageName === NEXT_PACKAGE) {
    verifyLotusNextArtifact({
      distDirectory: dist,
      expectedIdentity: source.artifactLock,
    });
  }
  return files;
}

function stageDist(source, root = ROOT, identity = sourceIdentity(source)) {
  const dist = path.join(source.sourceRoot, "dist");
  verifyDist(source, dist);
  const output = path.join(root, ".lotus-dist");
  const resource = path.join(root, ".bodhi-frontend");
  const stagingParent = path.join(root, "tmp");
  fs.mkdirSync(stagingParent, { recursive: true });
  const stagingParentMetadata = fs.lstatSync(stagingParent);
  if (stagingParentMetadata.isSymbolicLink() || !stagingParentMetadata.isDirectory()) {
    throw new Error("Bodhi staging parent must be a real directory.");
  }
  const staging = fs.mkdtempSync(
    path.join(stagingParent, "bodhi-frontend-stage-"),
  );
  const stagedOutput = path.join(staging, "lotus-dist");
  const stagedResource = path.join(staging, "bodhi-frontend");
  try {
    fs.cpSync(dist, stagedOutput, { recursive: true });
    const files = verifyDist(source, stagedOutput);
    const after = sourceIdentity(source);
    if (JSON.stringify(identity) !== JSON.stringify(after)) {
      throw new Error(
        "Frontend source identity changed during staging; no generated output was replaced.",
      );
    }
    const receipt = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      mode: source.mode,
      packageName: source.packageName,
      version: source.version,
      ...after,
      contentHash: contentHash(files),
      files,
    };
    fs.mkdirSync(stagedResource, { recursive: true });
    if (source.packageName === NEXT_PACKAGE) {
      fs.cpSync(stagedOutput, path.join(stagedResource, "dist"), {
        recursive: true,
      });
      const resourceFiles = verifyDist(
        source,
        path.join(stagedResource, "dist"),
      );
      if (JSON.stringify(files) !== JSON.stringify(resourceFiles)) {
        throw new Error(
          "Copied frontend resources changed during staging; no generated output was replaced.",
        );
      }
    }
    fs.writeFileSync(
      path.join(stagedResource, RECEIPT),
      `${JSON.stringify(receipt)}\n`,
    );

    // Only generated outputs are replaced, and only after the staged copies
    // have independently passed verification.
    for (const [target, staged] of [
      [output, stagedOutput],
      [resource, stagedResource],
    ]) {
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staged, target);
    }
    console.log(
      `Verified ${source.packageName} ${receipt.sourceRevision || source.version}${receipt.sourceDirty ? " (dirty source)" : ""}: sha256 ${receipt.contentHash}`,
    );
    return receipt;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function verifyStaged(source = resolveSource(), root = ROOT) {
  const output = path.join(root, ".lotus-dist");
  const resource = path.join(root, ".bodhi-frontend");
  const files = verifyDist(source, output);
  if (source.packageName === NEXT_PACKAGE) {
    const resourceFiles = verifyDist(source, path.join(resource, "dist"));
    if (JSON.stringify(resourceFiles) !== JSON.stringify(files)) {
      throw new Error("Bodhi frontend resource does not match .lotus-dist.");
    }
  } else if (fs.existsSync(path.join(resource, "dist"))) {
    throw new Error("The legacy rollback receipt must not carry a second Tauri frontend.");
  }
  const identity = sourceIdentity(source);
  const expected = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    mode: source.mode,
    packageName: source.packageName,
    version: source.version,
    ...identity,
    contentHash: contentHash(files),
    files,
  };
  const receipt = readJson(path.join(resource, RECEIPT));
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) {
    throw new Error("Staged frontend receipt does not match the selected artifact.");
  }
  return receipt;
}

module.exports = {
  ROOT,
  NEXT_PACKAGE,
  LEGACY_PACKAGE,
  RECEIPT,
  RECEIPT_SCHEMA_VERSION,
  ARTIFACT_MANIFEST_FILE,
  resolveSource,
  sourceIdentity,
  localBuildEnvironment,
  safeRelative,
  inventory,
  contentHash,
  verifyDist,
  stageDist,
  verifyStaged,
};

if (require.main === module) {
  try {
    const command = process.argv[2] || "stage";
    if (command === "info") {
      const source = resolveSource();
      console.log(JSON.stringify({
        mode: source.mode,
        packageName: source.packageName,
        version: source.version,
        sourceRoot: source.sourceRoot,
        artifactLock: source.artifactLock,
      }, null, 2));
    }
    else if (command === "stage") require("./web-build.cjs").buildFrontend();
    else if (command === "verify-staged") {
      const receipt = verifyStaged();
      console.log(
        `Staged ${receipt.packageName}@${receipt.version} matches receipt ${receipt.contentHash}.`,
      );
    } else throw new Error(`Unknown command ${command}; use stage, verify-staged or info.`);
  } catch (error) {
    console.error(`Frontend: ${error.message}`);
    process.exitCode = 1;
  }
}
