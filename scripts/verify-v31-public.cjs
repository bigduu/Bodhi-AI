'use strict';
const assert=require('node:assert/strict'), crypto=require('node:crypto'), {spawn,execFileSync}=require('node:child_process');
const release=JSON.parse(execFileSync('gh',['api','repos/bigduu/Bodhi-AI/releases/426837551'],{encoding:'utf8'}));
assert.equal(release.draft,false); assert.equal(release.prerelease,false); assert.equal(release.tag_name,'app-v2026.10.31');
assert.equal(release.target_commitish,'ebd73744e75ea20ecd068a730213eeeb3f26e52b');
const names=['Bodhi.AI_2026.10.31_aarch64.dmg','Bodhi.AI_aarch64.app.tar.gz','Bodhi.AI_2026.10.31_amd64.AppImage','Bodhi.AI_2026.10.31_amd64.deb','Bodhi.AI-2026.10.31-1.x86_64.rpm','Bodhi.AI_2026.10.31_x64-setup.exe','bodhi-release-v31-replacement.json'];
assert.equal(release.assets.length,names.length);
const assets=names.map(name=>{
  const rows=release.assets.filter(asset=>asset.name===name); assert.equal(rows.length,1);
  const item=rows[0]; assert.equal(item.state,'uploaded'); assert.match(item.digest,/^sha256:[0-9a-f]{64}$/);
  assert.equal(item.browser_download_url,`https://github.com/bigduu/Bodhi-AI/releases/download/app-v2026.10.31/${name}`);
  return item;
});
function download(asset){return new Promise((resolve,reject)=>{
  const proc=spawn('curl',['--fail','--location','--silent','--show-error','--max-time','900',asset.browser_download_url]);
  const hash=crypto.createHash('sha256'); let size=0,errors='';
  proc.stdout.on('data',chunk=>{size+=chunk.length;hash.update(chunk)});
  proc.stderr.on('data',chunk=>{errors+=chunk.toString().slice(0,2048)});
  proc.on('error',reject); proc.on('close',code=>{if(code!==0)return reject(new Error(`download ${asset.name}: ${errors.trim()}`));
    try {assert.equal(size,asset.size); const digest='sha256:'+hash.digest('hex');assert.equal(digest,asset.digest);
      resolve({name:asset.name,size,digest});} catch(error){reject(error)} });
});}
async function retry(asset){let error; for(let i=0;i<3;i++){try{return await download(asset)}catch(e){error=e;if(!String(e.message).startsWith('download '))throw e;if(i<2)await new Promise(r=>setTimeout(r,2000*(i+1)));}}throw error;}
(async()=>{const results=[];let index=0;async function worker(){while(index<assets.length){const asset=assets[index++];const value=await retry(asset);results.push(value);console.log(JSON.stringify(value));}}
await Promise.all(Array.from({length:3},worker));assert.equal(results.length,names.length);console.log('All public release downloads match their GitHub SHA-256 and size.');})().catch(e=>{console.error(e.message);process.exitCode=1});
