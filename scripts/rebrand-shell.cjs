/**
 * Legacy shell rebrand entrypoint.
 *
 * Bodhi shell branding is now fixed (name/identifier/title do not change).
 * internal/public only controls frontend startup confirmation behavior.
 */

function parseArgs(argv) {
  return argv.reduce((acc, arg) => {
    if (!arg.startsWith("--")) return acc;
    const raw = arg.slice(2);
    const eqIndex = raw.indexOf("=");
    if (eqIndex === -1) {
      acc[raw] = true;
      return acc;
    }
    const key = raw.slice(0, eqIndex);
    const value = raw.slice(eqIndex + 1);
    acc[key] = value;
    return acc;
  }, {});
}

const args = parseArgs(process.argv.slice(2));
const target = args.target || "internal";
const checkOnly = Boolean(args.check);

if (!["internal", "public"].includes(target)) {
  console.error(`❌ Unknown target: ${target}`);
  process.exit(1);
}

const modeLabel = target.toUpperCase();
if (checkOnly) {
  console.log(`✅ Shell brand check: ${modeLabel} (fixed as Bodhi, no file changes needed)`);
  process.exit(0);
}

console.log(`\n🎛️  Shell mode: ${modeLabel}`);
console.log("   Shell branding is fixed to Bodhi");
console.log("   No Cargo/Tauri files are rewritten\n");

console.log(`✨ Shell mode ready: ${target}\n`);
