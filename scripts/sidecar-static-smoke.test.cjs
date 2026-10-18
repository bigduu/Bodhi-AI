const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { smokeStaticOverride } = require("./sidecar-static-smoke.cjs");

// A separate Node HTTP fixture exercises the smoke harness, not Bamboo itself.
// Passing these tests never constitutes native/full-binary release acceptance.
function fixture(t, mode = "valid") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bodhi-static-harness-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const frontend = path.join(root, "frontend");
  fs.mkdirSync(path.join(frontend, "assets"), { recursive: true });
  fs.writeFileSync(path.join(frontend, "index.html"), '<script src="/assets/app.js"></script>');
  fs.writeFileSync(path.join(frontend, "assets/app.js"), "// fixture frontend");
  const server = path.join(root, "server.cjs");
  fs.writeFileSync(server, `
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const args=process.argv.slice(2);const option=name=>args[args.indexOf(name)+1];
const mode=${JSON.stringify(mode)};
const port=Number(option('--port')),staticDir=option('--static-dir'),data=option('--data-dir');
if(!path.isAbsolute(data)||!path.isAbsolute(staticDir)||process.env.BAMBOO_DATA_DIR!==data||!process.env.BAMBOO_JIANDU_DATA_DIR.startsWith(path.dirname(data)))throw Error('unisolated data');
if(process.env.BAMBOO_FRONTEND_BUILD_MODE||process.env.BAMBOO_LOCAL_PATH||process.env.OPENAI_API_KEY||process.env.GITHUB_TOKEN)throw Error('inherited runtime controls or credentials');
const server=http.createServer((req,res)=>{
 if(req.url==='/healthz'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({status:'ok',version:mode==='server-version'?'2026.10.17':'2026.10.18'}));}
 if(req.url==='/api/v1/health')return res.end(mode==='api'?'changed':'OK');
 if(mode==='embedded')return res.end('embedded index instead of Bodhi resource');
 if(req.url.startsWith('/bodhi-external-')){
  if(mode==='ignore-static'){res.statusCode=404;return res.end('not in embedded frontend');}
  return res.end(fs.readFileSync(path.join(staticDir,req.url.slice(1))));
 }
 const file=req.url.startsWith('/assets/')?path.join(staticDir,req.url.slice(1)):path.join(staticDir,'index.html');
 res.end(mode==='asset'&&req.url.startsWith('/assets/')?'changed':fs.readFileSync(file));
});
server.listen(port,'127.0.0.1',()=>{if(mode!=='no-bind-signal')console.log('Unified server running on http://127.0.0.1:'+port);});
`);
  let child;
  let generatedRoot;
  const options = { binary: process.execPath, version: "2026.10.18", staticDirectory: frontend, timeoutMs: 500,
    readVersion() { return mode === "cli-version" ? "bamboo 2026.10.17\n" : "bamboo 2026.10.18\n"; },
    launch(binary, args, settings) {
      generatedRoot = path.dirname(settings.env.BAMBOO_DATA_DIR);
      child = spawn(binary, [server, ...args], settings);
      return child;
    } };
  return { options, state: () => ({ child, generatedRoot }) };
}

test("static smoke verifies full-binary version, API, Bodhi index/assets and external directory precedence", async (t) => {
  const f = fixture(t);
  const receipt = await smokeStaticOverride(f.options);
  assert.equal(receipt.mode, "embedded");
  assert.equal(receipt.embeddedFrontend, true);
  assert.equal(receipt.externalDirectoryOverride, true);
  assert.equal(receipt.httpVersion, "2026.10.18");
  assert.equal(receipt.spaFallback, true);
  assert.equal(fs.existsSync(f.state().generatedRoot), false);
  assert.ok(f.state().child.exitCode !== null || f.state().child.signalCode !== null);
});

for (const [mode, pattern] of [
  ["cli-version", /CLI version differs/],
  ["server-version", /server version differs/],
  ["embedded", /Embedded frontend replaced/],
  ["ignore-static", /HTTP.*failed/],
  ["asset", /frontend asset changed/],
  ["api", /health API changed/],
  ["no-bind-signal", /bind signal did not complete/],
]) test(`static smoke fails closed for ${mode} and settles the owned child`, async (t) => {
  const f = fixture(t, mode);
  await assert.rejects(smokeStaticOverride(f.options), pattern);
  if (f.state().child) {
    assert.ok(f.state().child.exitCode !== null || f.state().child.signalCode !== null);
    assert.equal(fs.existsSync(f.state().generatedRoot), false);
  }
});

test("static smoke aborts readiness and cleans the owned HTTP process", async (t) => {
  const f = fixture(t, "no-bind-signal");
  const controller = new AbortController();
  const pending = smokeStaticOverride({ ...f.options, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(new Error("fixture interrupted")), 100);
  try { await assert.rejects(pending, /fixture interrupted/); }
  finally { clearTimeout(timer); }
  if (f.state().child) assert.ok(f.state().child.exitCode !== null || f.state().child.signalCode !== null);
});
