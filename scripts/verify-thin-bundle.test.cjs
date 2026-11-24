const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { requireShellOnly } = require("./verify-thin-bundle.cjs");

test("the extracted thin package must omit components on every platform", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-thin-package-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const resources = path.join(directory, "resources");
  fs.mkdirSync(resources);
  fs.writeFileSync(path.join(directory, "bodhi.exe"), "shell");
  assert.doesNotThrow(() => requireShellOnly(directory));
  for (const name of ["Bamboo.EXE", "bamboo-aarch64-apple-darwin", "browser-runtime", "frontend", "lotus-next-manifest.json"]) {
    const file = path.join(resources, name);
    fs.writeFileSync(file, "unwanted");
    assert.throws(() => requireShellOnly(directory), /contains a component/);
    fs.unlinkSync(file);
  }
});
