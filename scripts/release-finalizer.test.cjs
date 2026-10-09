const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8');
const body = workflow.slice(workflow.indexOf('  finalize-release:'));
const program = body.split("node --input-type=module - <<'NODE'\n")[1].split('          NODE')[0].split('\n').map(line => line.replace(/^          /, '')).join('\n');
const version = '2026.10.9';
const source = 'a'.repeat(40);
const tag = `bodhi-draft-v${version}-42-1`;
function fixture() {
  const names = [`Bodhi.AI-${version}-1.x86_64.rpm`, `Bodhi.AI_${version}_aarch64.dmg`, `Bodhi.AI_${version}_amd64.AppImage`, `Bodhi.AI_${version}_amd64.deb`, `Bodhi.AI_${version}_x64-setup.exe`, `Bodhi.AI_${version}_x64.dmg`, 'Bodhi.AI_aarch64.app.tar.gz', 'Bodhi.AI_x64.app.tar.gz'];
  return {draft:{id:99, draft:true, prerelease:false, tag_name:tag, target_commitish:source, assets:names.map((name,i) => ({id:i+1,name,state:'uploaded',size:2e6,digest:'sha256:'+'b'.repeat(64),url:`https://api.github.com/repos/bigduu/Bodhi-AI/releases/assets/${i+1}`,browser_download_url:`https://github.com/bigduu/Bodhi-AI/releases/download/untagged-abcdef/${name}`}))}};
}
function run(fixture) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhi-finalizer-test-'));
  try {
    const file = path.join(directory, 'fixture.json'), calls = path.join(directory, 'calls.jsonl');
    fs.writeFileSync(file, JSON.stringify(fixture));
    fs.writeFileSync(path.join(directory, 'gh'), `#!/usr/bin/env node
const fs=require('node:fs');
const fixture=JSON.parse(fs.readFileSync(process.env.FINALIZER_FIXTURE));
const args=process.argv.slice(2), endpoint=args.find(a=>a.startsWith('repos/'));
const method=args.includes('--method')?args[args.indexOf('--method')+1]:'GET';
const request={endpoint,method};
if(method==='PATCH')request.body=JSON.parse(fs.readFileSync(0,'utf8'));
const previous=fs.existsSync(process.env.FINALIZER_CALLS)?fs.readFileSync(process.env.FINALIZER_CALLS,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];
fs.appendFileSync(process.env.FINALIZER_CALLS,JSON.stringify(request)+'\\n');
const send=data=>process.stdout.write(JSON.stringify(data));
if(endpoint.includes('releases?'))send([[fixture.draft,...(fixture.otherReleases||[])]]);
else if(endpoint.endsWith('releases/99')&&method==='GET'){
 const draft=structuredClone(fixture.draft);
 if(fixture.tamperFresh&&previous.filter(c=>c.endpoint===endpoint&&c.method==='GET').length)draft.assets[0].digest='sha256:'+'c'.repeat(64);
 send(draft);
}else if(endpoint.endsWith('releases/99')&&method==='PATCH'){
 const draft=structuredClone(fixture.draft);Object.assign(draft,request.body);
 for(const asset of draft.assets)asset.browser_download_url='https://github.com/bigduu/Bodhi-AI/releases/download/'+draft.tag_name+'/'+asset.name;
 draft.html_url='https://github.com/bigduu/Bodhi-AI/releases/tag/'+draft.tag_name;send(draft);
}else if(endpoint.includes('git/ref/tags/')){
 if(fixture.existingTag)send({object:{sha:'c'.repeat(40)}});
 else {process.stderr.write('gh: Not Found (HTTP 404)');process.exitCode=1;}
}else {process.stderr.write('unexpected endpoint: '+endpoint);process.exitCode=2;}
`, {mode:0o700});
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], {input:program,encoding:'utf8',env:{...process.env,PATH:directory+path.delimiter+process.env.PATH,FINALIZER_FIXTURE:file,FINALIZER_CALLS:calls,GITHUB_REPOSITORY:'bigduu/Bodhi-AI',GITHUB_SHA:source,RELEASE_VERSION:version,RELEASE_TAG:'app-v'+version,DRAFT_TAG:tag}});
    const requests = fs.existsSync(calls) ? fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse) : [];
    return {result,requests};
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
}
test('actual workflow finalizer publishes one verified draft by ID and preserves assets', () => {
  const {result,requests}=run(fixture());
  assert.equal(result.status,0,result.stderr);
  const patches=requests.filter(r=>r.method==='PATCH');
  assert.equal(patches.length,1);
  assert.equal(patches[0].endpoint,'repos/bigduu/Bodhi-AI/releases/99');
  assert.equal(patches[0].body.draft,false);
  assert.equal(patches[0].body.tag_name,'app-v'+version);
  assert.equal(patches[0].body.target_commitish,source);
  assert.ok(!requests.some(r=>r.endpoint.includes('releases/tags/')));
});
for(const [name,mutate] of [
  ['an existing final release, including a draft',f=>{f.otherReleases=[{id:100,tag_name:'app-v'+version,draft:true}];}],
  ['an existing final tag',f=>{f.existingTag=true;}],
  ['a different product source',f=>{f.draft.target_commitish='c'.repeat(40);}],
  ['a missing Intel DMG',f=>{f.draft.assets=f.draft.assets.filter(a=>!a.name.endsWith('_x64.dmg'));}],
  ['a missing Windows installer',f=>{f.draft.assets=f.draft.assets.filter(a=>!a.name.endsWith('.exe'));}],
  ['an invalid content digest',f=>{f.draft.assets[0].digest=null;}],
  ['an asset changed immediately before publication',f=>{f.tamperFresh=true;}],
]) test('actual workflow rejects '+name+' before any publication',()=>{
  const f=fixture();mutate(f);const {result,requests}=run(f);
  assert.notEqual(result.status,0);
  assert.equal(requests.filter(r=>r.method==='PATCH').length,0);
});
