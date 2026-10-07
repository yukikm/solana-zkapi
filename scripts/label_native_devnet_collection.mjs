/** Label a generic read-only chain collection with the native public projection's
 * precise count semantics. Never reads native custody, journals or private config. */
import assert from 'node:assert/strict';
import {readFile,lstat,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename,resolve} from 'node:path';
import {parseStrictJson} from '@zkapi/solana-sdk/trust';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function publicInput(path){
  const stat=await lstat(path);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=1024*1024);
  const raw=await readFile(path);return{raw,value:parseStrictJson(raw)};
}
async function main(){
  const args=process.argv.slice(2),options=new Map();assert.equal(args.length,6);
  for(let i=0;i<args.length;i+=2){assert.ok(['--base','--projection','--output'].includes(args[i])&&!options.has(args[i])&&args[i+1]);options.set(args[i],resolve(args[i+1]));}
  const base=await publicInput(options.get('--base')),projection=await publicInput(options.get('--projection'));
  assert.equal(base.value.passed,true);assert.equal(base.value.network_send_counts_independently_observable,false);
  const source=base.value.source_reports.find(row=>row.name===basename(options.get('--projection')));
  assert.equal(source?.sha256,hash(projection.raw));
  assert.equal(base.value.sdk_reported_auth_sends,projection.value.authSends);
  assert.equal(base.value.sdk_reported_inference_sends,projection.value.inferenceSends);
  const origin=projection.value.projection_origin;assert.ok(origin&&typeof origin==='object'&&!Array.isArray(origin));
  assert.equal(typeof origin.authSendsFieldMeaning,'string');
  const result={...base.value,
    scope:'Independent read-only finalized chain verification for installed native clientd runtime and actual OpenClaw acceptance projection; not provider billing verification',
    base_collector_result_sha256:hash(base.raw),native_public_projection_sha256:hash(projection.raw),projection_origin:origin,
    recorded_unique_authorizations:base.value.sdk_reported_auth_sends,auth_http_packet_count:null,
    recorded_unique_inference_dispatches:base.value.sdk_reported_inference_sends,
    projection_reported_inference_replays:base.value.sdk_reported_inference_replays,
    projection_reported_automatic_transaction_resends:base.value.sdk_reported_automatic_transaction_resends,
    projection_adapter_note:'The unchanged generic collector consumed a native acceptance projection. Its authSends field counts distinct authorization UUIDs with exact saved bodies, not HTTP packets; AUTH retry count is not independently known. Inference counts are durably recorded distinct operation dispatches. This run has separate native installation and ledger provenance from the external application SDK run. Finalized transaction bytes, signatures, instruction amounts and token deltas were independently checked through read-only RPC; provider packets and billing signatures were not.',
  };
  for(const name of ['sdk_reported_auth_sends','sdk_reported_inference_sends','sdk_reported_inference_replays','sdk_reported_automatic_transaction_resends'])delete result[name];
  await writeFile(options.get('--output'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o644});
  console.log(JSON.stringify({passed:true,recorded_unique_authorizations:result.recorded_unique_authorizations,auth_http_packet_count:null,recorded_unique_inference_dispatches:result.recorded_unique_inference_dispatches,base_collector_result_sha256:result.base_collector_result_sha256}));
}
main().catch(()=>{console.error('Native collection labelling did not complete; no labelled success report written.');process.exitCode=1;});
