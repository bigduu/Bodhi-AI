#!/usr/bin/env node
// Exercise the actual bundled Node, Playwright host, and Chromium together.
// This runs after Tauri creates the .app; no system Chrome or Nova is involved.
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { ROOT } = require("./lotus-dist.cjs");
const { verifyRuntime } = require("./browser-runtime.cjs");

function browserPids(executable) {
  const rows = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n");
  return rows.flatMap((row) => {
    const match = row.trim().match(/^(\d+)\s+(.*)$/);
    return match && match[2].includes(executable) && !match[2].includes("ps -axo")
      ? [Number(match[1])]
      : [];
  });
}

function hostClient(node, host, browser) {
  const child = spawn(node, [host], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BAMBOO_BROWSER_EXECUTABLE: browser },
  });
  let sequence = 0;
  let stdout = "";
  let stderr = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (;;) {
      const end = stdout.indexOf("\n");
      if (end < 0) break;
      const line = stdout.slice(0, end);
      stdout = stdout.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.event) continue;
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok) request.resolve(message.result);
      else request.reject(new Error(`${message.code}: ${message.error}`));
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_000); });
  child.on("exit", (code, signal) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`browser host exited (${code ?? signal}): ${stderr}`));
    }
    pending.clear();
  });
  return {
    child,
    request(action, args = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`browser host ${action} timed out: ${stderr}`));
        }, 30_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, action, args })}\n`);
      });
    },
    async stop() {
      if (child.exitCode === null) {
        try { await this.request("close"); } catch { /* fallback below */ }
      }
      child.stdin.end();
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
          try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
          resolve();
        }, 5_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

async function main() {
  const target = process.argv[2];
  if (!target?.endsWith("-apple-darwin")) throw new Error("pass a macOS target triple");
  const app = path.resolve(process.argv[3] || path.join(ROOT, "target", target, "release", "bundle", "macos", "Bodhi AI.app"));
  const runtime = verifyRuntime(path.join(app, "Contents", "Resources", "BodhiBrowser"), target);
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" });
  const before = browserPids(runtime.browser);
  if (before.length) throw new Error(`A browser from this exact bundle is already running: ${before.join(", ")}`);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Bodhi browser acceptance</title><label for='value'>Value</label><input id='value'><button id='submit' onclick=\"document.querySelector('output').textContent=document.querySelector('#value').value\">Apply</button><output></output>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const client = hostClient(runtime.node, runtime.host, runtime.browser);
  try {
    const initial = await client.request("state");
    const navigated = await client.request("navigate", { url, expected_epoch: initial.page_epoch });
    const filled = await client.request("fill_selector", { selector: "#value", text: "bundled-browser-ok", expected_epoch: navigated.page_epoch });
    await client.request("click_selector", { selector: "#submit", expected_epoch: filled.page_epoch });
    const dom = await client.request("dom");
    assert.equal(dom.url, url);
    assert.match(dom.html, /bundled-browser-ok/);
    assert.match(dom.snapshot, /bundled-browser-ok/);
    const screenshot = await client.request("screenshot");
    const jpeg = Buffer.from(screenshot.data, "base64");
    assert.equal(screenshot.mime_type, "image/jpeg");
    assert.equal(jpeg.subarray(0, 2).toString("hex"), "ffd8");
    assert.ok(jpeg.length > 1000);
    console.log(`Bundled browser ${runtime.chromiumVersion} / Node ${runtime.nodeVersion}: DOM, input, JPEG ${jpeg.length} bytes`);
  } finally {
    await client.stop();
    await new Promise((resolve) => server.close(resolve));
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!browserPids(runtime.browser).length) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Bundled browser process remained after host close: ${browserPids(runtime.browser).join(", ")}`);
}

main().catch((error) => {
  console.error(`Bundled browser smoke: ${error.message}`);
  process.exitCode = 1;
});
