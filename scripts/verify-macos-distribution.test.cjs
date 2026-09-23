const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { oneEntry, parseCodesignDisplay, sameCandidate } = require("./verify-macos-distribution.cjs");

const TEAM = "AB12CD34EF";
const VALID = [
  "CodeDirectory v=20500 size=120 flags=0x10000(runtime) hashes=2+1 location=embedded",
  "CDHash=abcdef0123456789abcdef0123456789abcdef01",
  `Authority=Developer ID Application: Example (${TEAM})`,
  "Authority=Developer ID Certification Authority",
  `TeamIdentifier=${TEAM}`,
  "Timestamp=Sep 23, 2026 at 12:00:00",
].join("\n");

test("distribution signature requires Developer ID, matching team, hardened runtime, and timestamp", () => {
  assert.equal(parseCodesignDisplay(VALID, TEAM).cdHash, "abcdef0123456789abcdef0123456789abcdef01");
  assert.throws(() => parseCodesignDisplay(`${VALID}\nSignature=adhoc`, TEAM), /Ad-hoc/);
  assert.throws(() => parseCodesignDisplay(VALID, "ZY98XW76VU"), /expected Developer ID/);
  assert.throws(() => parseCodesignDisplay(VALID.replace("(runtime)", "(none)"), TEAM), /hardened runtime/);
  assert.throws(() => parseCodesignDisplay(VALID.replace(/^Timestamp=.*$/m, "Timestamp=none"), TEAM), /timestamp/);
  assert.throws(() => parseCodesignDisplay(VALID.replace("Developer ID Application", "Apple Development"), TEAM), /expected Developer ID/);
});

test("release gate requires exactly one candidate archive and matching app identity", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-distribution-artifacts-"));
  try {
    assert.throws(() => oneEntry(directory, (name) => name.endsWith(".dmg"), "DMG"), /found 0/);
    fs.writeFileSync(path.join(directory, "first.dmg"), "first");
    assert.equal(path.basename(oneEntry(directory, (name) => name.endsWith(".dmg"), "DMG")), "first.dmg");
    fs.writeFileSync(path.join(directory, "second.dmg"), "second");
    assert.throws(() => oneEntry(directory, (name) => name.endsWith(".dmg"), "DMG"), /found 2/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  const candidate = { version: "2026.9.25", cdHash: "a", browserFilesSha256: "b", browserHostSha256: "c", signedMachOCount: 7 };
  assert.doesNotThrow(() => sameCandidate({ ...candidate }, candidate, "archive"));
  assert.throws(() => sameCandidate({ ...candidate, browserFilesSha256: "changed" }, candidate, "DMG"), /browserFilesSha256/);
});
