import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('offline upgrade CLI consumes old status, preserves files and never echoes private fields',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zkapi-upgrade-cli-'));
  try {
    const file=join(dir,'status.json'),link=join(dir,'link.json');
    const run=(path)=>spawnSync(process.execPath,[fileURLToPath(new URL('./cli.mjs',import.meta.url)),'upgrade-plan','--status-file',path],{encoding:'utf8',timeout:10_000});
    const status={wallet_status:'active',balance_micro_usdc:'123',wallet_operation:null,wallet_emergency_escape:null,
      recovery_required:false,in_flight:0,phase:'ready',unresolved_operations:[],private:'SECRET'};
    await writeFile(file,JSON.stringify(status));
    const r=run(file);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).assessment,'needs_attention');
    assert.ok(!r.stdout.includes('SECRET'));assert.equal(r.stderr,'');
    await writeFile(file,'{"wallet_status":"closed","wallet_status":"active"}');assert.equal(run(file).status,1);
    await symlink(file,link);assert.equal(run(link).status,1);
    const missing=run(join(dir,'SECRET'));assert.equal(missing.status,1);assert.ok(!missing.stderr.includes('SECRET'));
  } finally {await rm(dir,{recursive:true,force:true});}
});
