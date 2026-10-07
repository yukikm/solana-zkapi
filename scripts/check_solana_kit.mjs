/** Guard the active source and locked/installed dependency graphs against legacy Solana clients. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
const root=resolve(process.argv[2]??'.');
const forbidden=new Set(['@solana/web3.js','@solana/web3-compat']);
const lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));
let packages=0;
for(const [location,entry] of Object.entries(lock.packages)){
  assert.ok(![...forbidden].some(name=>location.endsWith('node_modules/'+name)),`legacy locked dependency: ${location}`);
  assert.ok(!forbidden.has(entry.name),`legacy aliased package: ${location}`);
  for(const field of ['dependencies','optionalDependencies','peerDependencies'])for(const [name,version] of Object.entries(entry[field]??{})){
    assert.ok(!forbidden.has(name)&&![...forbidden].some(legacy=>String(version).startsWith('npm:'+legacy+'@')),`legacy dependency: ${location} ${name}`);
  }
  if(location.startsWith('node_modules/')&&!entry.link){
    let manifest;try{manifest=JSON.parse(await readFile(join(root,location,'package.json'),'utf8'));}
    catch(error){if(error.code==='ENOENT'&&entry.optional)continue;throw error;}
    assert.ok(!forbidden.has(manifest.name),`legacy installed alias: ${location}`);packages++;
  }
}
const kit=JSON.parse(await readFile(join(root,'node_modules/@solana/kit/package.json'),'utf8'));
assert.equal(kit.version,'8.4.0');
let files=0;
async function scan(directory){
  for(const item of await readdir(directory,{withFileTypes:true})){if(['node_modules','target','dist','.git','vendor','work'].includes(item.name)||item.isSymbolicLink())continue;const path=join(directory,item.name);
    if(item.isDirectory()){await scan(path);continue;}
    if(!/\.(?:ts|tsx|js|mjs|cjs|rs|py)$/.test(item.name))continue;
    const source=await readFile(path,'utf8');
    for(const name of forbidden){const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');assert.ok(!new RegExp(`(?:from\\s*|import\\s*\\(|require\\s*\\(|import\\s*)["']${escaped}(?:/[^"']*)?["']`).test(source),`legacy import in ${relative(root,path)}`);}
    files++;
  }
}
for(const directory of ['packages','apps','scripts','services','tests','browser-chat','legacy-wallet'])try{await scan(join(root,directory));}catch(error){if(error.code!=='ENOENT')throw error;}
console.log(JSON.stringify({passed:true,kit:kit.version,locked_installed_packages:packages,active_source_files:files,legacy_imports:0,legacy_packages:0}));
