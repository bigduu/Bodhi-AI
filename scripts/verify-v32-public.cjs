'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {spawn, execFileSync} = require('node:child_process');
const out = require('./release-output.cjs');
const finalizer = require('./release-finalizer-v2.cjs');
const version = '2026.10.32';
const source = '6986d6385937116df5bb04f91b2e00ffc486ba02';
const runId = '40826696819';
const controller = 'e167c9c0f070dd3da224804e732c3f823509d883';
function api(endpoint) { return JSON.parse(execFileSync('gh', ['api', `repos/bigduu/Bodhi-AI/${endpoint}`], {encoding:'utf8'})); }
const release = api(`releases/tags/app-v${version}`);
assert.equal(release.draft, false);
assert.equal(release.prerelease, false);
assert.equal(release.tag_name, `app-v${version}`);
assert.equal(release.target_commitish, source);
assert.equal(api(`git/ref/tags/app-v${version}`).object.sha, source);
const ctx = out.context({GITHUB_REPOSITORY:'bigduu/Bodhi-AI', RELEASE_VERSION:version, EXPECTED_SOURCE_SHA:source,
  ORIGINAL_RELEASE_RUN_ID:runId, ORIGINAL_RELEASE_ATTEMPT:'1', GITHUB_WORKFLOW_SHA:controller});
const manifestAsset = release.assets.filter(asset => asset.name === 'bodhi-release-v2.json');
assert.equal(manifestAsset.length, 1);
const manifest = JSON.parse(execFileSync('gh', ['api', `repos/bigduu/Bodhi-AI/releases/assets/${manifestAsset[0].id}`, '-H', 'Accept: application/octet-stream'], {encoding:'utf8'}));
finalizer.verifyPublished(ctx, release, manifest);
console.log(JSON.stringify({releaseId:release.id, version, source, runId, manifest:'verified'}));
const names = [...out.NATIVE_TARGETS.flatMap(target => out.names(version, target)), out.MANIFEST];
assert.equal(release.assets.length, names.length);
const assets = names.map(name => {
  const rows = release.assets.filter(asset => asset.name === name); assert.equal(rows.length, 1);
  const item = rows[0]; assert.equal(item.state, 'uploaded'); assert.match(item.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(item.browser_download_url, `https://github.com/bigduu/Bodhi-AI/releases/download/app-v${version}/${name}`);
  return item;
});
function download(asset) {return new Promise((resolve, reject) => {
  const proc = spawn('curl', ['--fail', '--location', '--silent', '--show-error', '--max-time', '900', asset.browser_download_url]);
  const hash = crypto.createHash('sha256'); let size = 0, errors = '';
  proc.stdout.on('data', chunk => {size += chunk.length; hash.update(chunk)});
  proc.stderr.on('data', chunk => {errors += chunk.toString().slice(0, 2048)});
  proc.on('error', reject); proc.on('close', code => {if(code !== 0) return reject(new Error(`download ${asset.name}: ${errors.trim()}`));
    try {assert.equal(size, asset.size); const digest = 'sha256:' + hash.digest('hex'); assert.equal(digest, asset.digest);
      resolve({name:asset.name, size, digest});} catch(error) {reject(error)} });
});}
async function retry(asset) {let error; for(let i = 0; i < 3; i++) {try {return await download(asset)} catch(e) {error = e; if(!String(e.message).startsWith('download ')) throw e; if(i < 2) await new Promise(r => setTimeout(r, 2000*(i+1)));}} throw error;}
(async () => {const results = []; let index = 0; async function worker() {while(index < assets.length) {const asset = assets[index++]; const value = await retry(asset); results.push(value); console.log(JSON.stringify(value));}}
  await Promise.all(Array.from({length:3}, worker)); assert.equal(results.length, names.length); console.log('All public release downloads match their manifest and GitHub SHA-256 and size.');
})().catch(e => {console.error(e.message); process.exitCode = 1});
