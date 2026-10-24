#!/usr/bin/env node

const args = process.argv.slice(2);
// Tauri's global verbosity flags may precede the subcommand. Keep them when
// routing development through preparation and frontend readiness checks.
const commandIndex = args.findIndex((arg) => !/^(?:-v+|--verbose)$/.test(arg));

if (args[commandIndex] === "dev") {
  const { runDevCommand } = require("./tauri-dev.cjs");
  runDevCommand([...args.slice(0, commandIndex), ...args.slice(commandIndex + 1)]);
} else {
  // Load the official CLI in this process so its arguments, interactive input,
  // exit status and signal handling retain their normal behavior.
  require("@tauri-apps/cli/tauri.js");
}
