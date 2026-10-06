#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");
const { ROOT, resolveSource, sourceIdentity, localBuildEnvironment } = require("./lotus-dist.cjs");

// These are startup-only routes. No frontend module or API request runs while
// the native shell is waiting for its existing managed-sidecar readiness proof.
function startupPlugin(identity, splash, requireRunId = true) {
  return {
    name: "bodhi-owned-development-frontend",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url, "http://127.0.0.1");
        if (!["/__bodhi_dev_identity", "/__bodhi_startup"].includes(url.pathname)) return next();
        if (url.searchParams.get("run") !== identity.runId && (requireRunId || url.pathname !== "/__bodhi_startup" || url.searchParams.has("run"))) {
          // A stale run must not serve the SPA fallback for another run's splash.
          response.writeHead(409, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
          response.end("This frontend belongs to a different Bodhi development run.");
          return;
        }
        response.writeHead(200, {
          "Content-Type": url.pathname === "/__bodhi_startup" ? "text/html" : "application/json",
          "Cache-Control": "no-store",
        });
        response.end(url.pathname === "/__bodhi_startup" ? splash : JSON.stringify(identity));
      });
    },
  };
}

async function runFrontend(source = resolveSource(), options = {}) {
  if (source.mode !== "local") throw new Error("Development requires a local Lotus Next checkout.");
  const env = localBuildEnvironment(source);
  Object.assign(process.env, env);
  // Match `npm run dev` in the selected checkout: the Lotus Vite config reads
  // cwd for its environment/schema and source identity, not only Vite's root.
  process.chdir(source.sourceRoot);
  const runId = options.runId || process.env.BODHI_DEV_RUN_ID || randomUUID();
  const port = options.port || Number(process.env.BODHI_DEV_PORT || 1420);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Bodhi development port.");
  const identity = {
    runId,
    pid: process.pid,
    sourceRoot: fs.realpathSync(source.sourceRoot),
    sourceRevision: sourceIdentity(source).sourceRevision,
  };
  const vite = options.vite || await import(pathToFileURL(createRequire(path.join(source.sourceRoot, "package.json")).resolve("vite")).href);
  const server = await vite.createServer({
    root: source.sourceRoot,
    server: { host: "127.0.0.1", port, strictPort: true },
    plugins: [startupPlugin(identity, fs.readFileSync(path.join(ROOT, "bodhi-splash/index.html"), "utf8"), Boolean(process.env.BODHI_DEV_RUN_ID))],
  });
  const close = () => {
    server.close().then(() => { process.exitCode = 0; }, (error) => {
      console.error(`Frontend shutdown failed: ${error.message}`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    await server.listen();
    console.log(`Bodhi frontend ready: pid=${identity.pid} checkout=${identity.sourceRoot} revision=${identity.sourceRevision} port=${port}`);
  } catch (error) {
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    await server.close();
    throw error;
  }
  return server;
}

module.exports = { runFrontend, startupPlugin };
if (require.main === module) runFrontend().catch((error) => {
  console.error(`Frontend: ${error.message}`);
  process.exitCode = 1;
});
