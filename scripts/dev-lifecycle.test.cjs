const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { runDevLifecycle } = require("./tauri-dev.cjs");
const { startupPlugin } = require("./web-dev.cjs");
const { allocateLoopbackPort, assertLoopbackPortAvailable, waitForCondition } = require("./managed-restart-contract.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-dev-lifecycle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "lotus-next");
  fs.mkdirSync(sourceRoot);
  fs.writeFileSync(path.join(sourceRoot, "package.json"), JSON.stringify({ name: "@bigduu/lotus-next", version: "0.0.0" }));
  const git = (...args) => execFileSync("git", ["-C", sourceRoot, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Bodhi Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  const sourceRevision = git("rev-parse", "HEAD").toString().trim();
  const events = path.join(root, "events");
  const command = (name, contents) => {
    const script = path.join(root, `${name}.cjs`);
    fs.writeFileSync(script, contents);
    return { command: process.execPath, args: [script] };
  };
  const record = `const fs=require('node:fs'); const record=(s)=>fs.appendFileSync(${JSON.stringify(events)},s+'\\n');`;
  const prepare = command("prepare", `${record}record('prepared');`);
  const frontend = command("frontend", `${record}
    const http=require('node:http');
    const identity={runId:process.env.BODHI_DEV_RUN_ID,pid:process.pid,sourceRoot:${JSON.stringify(fs.realpathSync(sourceRoot))},sourceRevision:${JSON.stringify(sourceRevision)}};
    http.createServer((req,res)=>{record('frontend-request');res.end(req.url.startsWith('/__bodhi_dev_identity')?JSON.stringify(identity):'<html>own frontend</html>');}).listen(Number(process.env.BODHI_DEV_PORT),'127.0.0.1',()=>record('frontend-ready'));
  `);
  const native = command("native", `${record}record('native-started');`);
  const env = { ...process.env, LOTUS_LOCAL_PATH: sourceRoot, LOTUS_SOURCE: "local", VITE_BACKEND_BASE_URL: "" };
  const readEvents = () => fs.existsSync(events) ? fs.readFileSync(events, "utf8").trim().split("\n") : [];
  return { root, sourceRoot, sourceRevision, prepare, frontend, native, env, command, record, readEvents };
}

test("occupied frontend port rejects before any preparation and leaves the foreign listener alive", async (t) => {
  const f = fixture(t);
  const foreign = net.createServer();
  await new Promise((resolve) => foreign.listen(0, "127.0.0.1", resolve));
  t.after(() => foreign.close());
  const port = foreign.address().port;
  await assert.rejects(runDevLifecycle({ ...f, port }), /occupied.*Requested checkout.*no build was started/);
  assert.deepEqual(f.readEvents(), []);
  await new Promise((resolve, reject) => { const socket = net.connect(port, "127.0.0.1", () => { socket.end(); resolve(); }); socket.on("error", reject); });
});

test("prepare failure never launches frontend or native", async (t) => {
  const f = fixture(t);
  const port = await allocateLoopbackPort();
  f.prepare = f.command("bad-prepare", `${f.record}record('prepare-failed');process.exit(7);`);
  await assert.rejects(runDevLifecycle({ ...f, port }), /status 7/);
  assert.deepEqual(f.readEvents(), ["prepare-failed"]);
  await assertLoopbackPortAvailable(port);
});

test("ordered preparation and exact child readiness precede native launch, normal exit releases frontend", async (t) => {
  const f = fixture(t);
  const port = await allocateLoopbackPort();
  await runDevLifecycle({ ...f, port });
  const events = f.readEvents();
  assert.equal(events[0], "prepared");
  assert(events.indexOf("frontend-ready") < events.indexOf("native-started"));
  assert(events.indexOf("frontend-request") < events.indexOf("native-started"));
  await assertLoopbackPortAvailable(port);
});

test("another run's identity never launches native and readiness failure cleans up its child", async (t) => {
  const f = fixture(t);
  const port = await allocateLoopbackPort();
  f.frontend = f.command("wrong-frontend", `${f.record}
    require('node:http').createServer((req,res)=>res.end(JSON.stringify({runId:'stale-run',pid:process.pid}))).listen(Number(process.env.BODHI_DEV_PORT),'127.0.0.1');`);
  await assert.rejects(runDevLifecycle({ ...f, port, readinessTimeoutMs: 400 }), /readiness.*identity does not match/);
  assert(!f.readEvents().includes("native-started"));
  await assertLoopbackPortAvailable(port);
});

test("frontend exit cancels readiness promptly instead of leaving a background poll", async (t) => {
  const f = fixture(t);
  const port = await allocateLoopbackPort();
  f.frontend = f.command("failed-frontend", "process.exit(8);");
  const start = Date.now();
  await assert.rejects(runDevLifecycle({ ...f, port, readinessTimeoutMs: 30_000 }), /frontend exited.*8/);
  assert(Date.now() - start < 3_000);
  assert(!f.readEvents().includes("native-started"));
  await assertLoopbackPortAvailable(port);
});

test("native failure is reported and releases the owned frontend", async (t) => {
  const f = fixture(t);
  const port = await allocateLoopbackPort();
  f.native = f.command("failed-native", "process.exit(9);");
  await assert.rejects(runDevLifecycle({ ...f, port }), /Tauri development exited with status 9/);
  await assertLoopbackPortAvailable(port);
});

test("native normal exit cleans a surviving descendant listener in its owned Unix group", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const port = await allocateLoopbackPort();
  const backendPort = await allocateLoopbackPort();
  const child = f.command("surviving-backend", `${f.record}require('node:net').createServer().listen(${backendPort},'127.0.0.1',()=>record('backend-listening'));`);
  f.native = f.command("parent-native", `${f.record}
    require('node:child_process').spawn(${JSON.stringify(child.command)},${JSON.stringify(child.args)},{stdio:'ignore'});
    const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(f.root, "events"))})&&fs.readFileSync(${JSON.stringify(path.join(f.root, "events"))},'utf8').includes('backend-listening')){clearInterval(timer);process.exit(0);}},10);
  `);
  await runDevLifecycle({ ...f, port });
  assert(f.readEvents().includes("backend-listening"));
  await assertLoopbackPortAvailable(port);
  await assertLoopbackPortAvailable(backendPort);
});

test("frontend failure after native launch stops the native listener too", async (t) => {
  const f = fixture(t);
  const port = await allocateLoopbackPort();
  const backendPort = await allocateLoopbackPort();
  fs.appendFileSync(f.frontend.args[0], `\nsetTimeout(()=>process.exit(17),1000);`);
  f.native = f.command("still-native", `${f.record}require('node:net').createServer().listen(${backendPort},'127.0.0.1',()=>record('native-listening'));`);
  await assert.rejects(runDevLifecycle({ ...f, port }), /frontend exited.*17/);
  assert(f.readEvents().includes("native-listening"));
  await assertLoopbackPortAvailable(port);
  await assertLoopbackPortAvailable(backendPort);
});

test("interruption during preparation cleans its subprocess without starting native", async (t) => {
  const f = fixture(t);
  const port = await allocateLoopbackPort();
  f.prepare = f.command("long-prepare", `${f.record}record('preparing'); require('node:net').createServer().listen(${port},'127.0.0.1');`);
  const abort = new AbortController();
  const running = runDevLifecycle({ ...f, port, signal: abort.signal });
  const settled = assert.rejects(running, /fixture interruption/);
  await waitForCondition(() => f.readEvents().includes("preparing"));
  abort.abort(new Error("fixture interruption"));
  await settled;
  assert(!f.readEvents().includes("native-started"));
  await assertLoopbackPortAvailable(port);
});

test("interruption after native launch releases both owned listeners", async (t) => {
  const f = fixture(t);
  const port = await allocateLoopbackPort();
  const backendPort = await allocateLoopbackPort();
  f.native = f.command("long-native", `${f.record}require('node:net').createServer().listen(${backendPort},'127.0.0.1',()=>record('native-listening'));`);
  const abort = new AbortController();
  const running = runDevLifecycle({ ...f, port, signal: abort.signal });
  const settled = assert.rejects(running, /fixture interruption/);
  await waitForCondition(() => f.readEvents().includes("native-listening"));
  abort.abort(new Error("fixture interruption"));
  await settled;
  await assertLoopbackPortAvailable(port);
  await assertLoopbackPortAvailable(backendPort);
});

test("native launch config overrides are rejected before preparation", async (t) => {
  const f = fixture(t);
  await assert.rejects(runDevLifecycle({ ...f, args: ["--config", "foreign.json"] }), /controls beforeDevCommand and devUrl/);
  assert.deepEqual(f.readEvents(), []);
});

test("startup route contains only the splash and rejects a stale run without SPA fallback", async (t) => {
  let middleware;
  startupPlugin({ runId: "this-run", pid: 123 }, "<html>Starting Bodhi</html>").configureServer({ middlewares: { use: (value) => { middleware = value; } } });
  const server = http.createServer((request, response) => middleware(request, response, () => response.end("SPA modules must not run")));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const splash = await fetch(`${origin}/__bodhi_startup?run=this-run`);
  assert.equal(splash.status, 200);
  assert.equal(await splash.text(), "<html>Starting Bodhi</html>");
  const stale = await fetch(`${origin}/__bodhi_startup?run=old-run`);
  assert.equal(stale.status, 409);
  assert(!/SPA modules/.test(await stale.text()));
  const identity = await fetch(`${origin}/__bodhi_dev_identity?run=this-run`);
  assert.deepEqual(await identity.json(), { runId: "this-run", pid: 123 });
});

test("production frontend API keeps the selected checkout cwd, strict port, and startup identity", async (t) => {
  const f = fixture(t);
  const port = await allocateLoopbackPort();
  const implementation = path.join(__dirname, "web-dev.cjs");
  f.frontend = f.command("actual-frontend", `${f.record}
    const {runFrontend}=require(${JSON.stringify(implementation)});
    const vite={async createServer(config){
      if(process.cwd()!==${JSON.stringify(fs.realpathSync(f.sourceRoot))}||config.root!==${JSON.stringify(f.sourceRoot)}||config.server.host!=='127.0.0.1'||config.server.strictPort!==true)throw new Error('wrong Vite root/cwd or port policy');
      record('vite-api-configured');
      let middleware;
      const server=require('node:http').createServer((req,res)=>middleware(req,res,()=>res.end('<html>frontend</html>')));
      const api={middlewares:{use(fn){middleware=fn;}},listen(){return new Promise((resolve)=>server.listen(config.server.port,config.server.host,resolve));},close(){return new Promise((resolve)=>server.close(resolve));}};
      for(const plugin of config.plugins)plugin.configureServer(api);
      return api;
    }};
    runFrontend({mode:'local',sourceRoot:${JSON.stringify(f.sourceRoot)},packageName:'@bigduu/lotus-next',version:'0.0.0'},{vite}).catch((error)=>{console.error(error);process.exitCode=1;});
  `);
  await runDevLifecycle({ ...f, port });
  assert(f.readEvents().includes("vite-api-configured"));
  await assertLoopbackPortAvailable(port);
});

test("native CLI receives owned config before cargo/app arguments and cannot start its old hook", async (t) => {
  const f = fixture(t);
  const port = await allocateLoopbackPort();
  const cli = path.join(f.root, "node_modules/@tauri-apps/cli/tauri.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  const observed = path.join(f.root, "native-args.json");
  fs.writeFileSync(cli, `require('node:fs').writeFileSync(${JSON.stringify(observed)},JSON.stringify(process.argv.slice(2)));`);
  delete f.native;
  await runDevLifecycle({ ...f, port, args: ["--", "--", "application-argument"] });
  const args = JSON.parse(fs.readFileSync(observed));
  assert.equal(args[0], "dev");
  assert.equal(args[1], "--config");
  const config = JSON.parse(args[2]);
  assert.equal(config.build.beforeDevCommand, null);
  const url = new URL(config.build.devUrl);
  assert.equal(url.origin, `http://127.0.0.1:${port}`);
  assert.equal(url.pathname, "/__bodhi_startup");
  assert.match(url.searchParams.get("run"), /^[0-9a-f-]{36}$/);
  assert.deepEqual(args.slice(3), ["--", "--", "application-argument"]);
  await assertLoopbackPortAvailable(port);
});
