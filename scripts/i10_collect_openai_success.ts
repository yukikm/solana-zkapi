import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash,createPublicKey,verify} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {jcsBytes,parseStrictJson} from '../packages/sdk/src/trust.ts';

const request='4f8434a4-9766-4903-9128-f0f33c3acdae',operation='3158cfca-c7b3-4891-aef0-54b9975b243e';
const previousRequest='3019e6e0-0ca7-48a8-844f-fd72bfb9d1fb';
const read=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const fileSha=(path:string)=>sha(readFileSync(path));
const directory='target/i10-live-demo-backend';
const dispatcher=read(`${directory}/dispatcher.json`),control=read(`${directory}/control.json`);
const db=Object.fromEntries((dispatcher.database_url as string).split(' ').map((part:string)=>part.split('=')));
assert.equal(db.dbname,'postgres');assert.ok(db.host.startsWith(process.cwd()+'/target/'));assert.match(db.port,/^[0-9]{1,5}$/);
const sql=`SELECT json_build_object(
 'read_only',current_setting('default_transaction_read_only'),
 'session',(SELECT row_to_json(s) FROM (SELECT state,close_requested,cap_micro::text,charged_nano::text,reserved_nano::text,active_operations FROM sessions WHERE request_id='${request}') s),
 'operation',(SELECT row_to_json(o) FROM (SELECT state,reservation_nano::text,charged_nano::text,observed_cost_nano::text,operator_loss_nano::text,dispatched_at IS NOT NULL AS dispatched,provider_request_id IS NOT NULL AS provider_request_id_present FROM operations WHERE request_id='${request}' AND operation_id='${operation}') o),
 'dispatch_attempts',(SELECT count(*) FROM dispatch_attempts WHERE request_id='${request}' AND operation_id='${operation}'),
 'finished_dispatch_attempts',(SELECT count(*) FROM dispatch_attempts WHERE request_id='${request}' AND operation_id='${operation}' AND finished_at IS NOT NULL),
 'provider_evidence',(SELECT count(*) FROM provider_evidence WHERE request_id='${request}' AND operation_id='${operation}'),
 'receipt_count',(SELECT count(*) FROM receipts WHERE request_id='${request}' AND operation_id='${operation}'),
 'receipt',(SELECT json_build_object('body',encode(canonical_body,'base64'),'hash',encode(receipt_hash,'hex'),'signature',encode(signature,'base64')) FROM receipts WHERE request_id='${request}' AND operation_id='${operation}'),
 'settlement',(SELECT row_to_json(s) FROM (SELECT charge_micro::text,state_signature IS NOT NULL AS signed FROM settlements WHERE request_id='${request}') s),
 'previous_dispatch_attempts',(SELECT count(*) FROM dispatch_attempts WHERE request_id='${previousRequest}'),
 'previous_receipt',(SELECT json_build_object('receipt_id',receipt_id,'reason',convert_from(canonical_body,'UTF8')::json->>'reason','evidence_kind',convert_from(canonical_body,'UTF8')::json->>'evidence_kind','charge_nano',convert_from(canonical_body,'UTF8')::json->>'charged_nano_usdc') FROM receipts WHERE request_id='${previousRequest}'))`;
const output=execFileSync('psql',['-X','-At','-v','ON_ERROR_STOP=1','-h',db.host,'-p',db.port,'-U','i10_devnet_test','-d','postgres','-c',sql],{env:{...process.env,PGOPTIONS:'-c default_transaction_read_only=on -c statement_timeout=5000'},encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});
const observed=JSON.parse(output);assert.equal(observed.read_only,'on');
assert.equal(observed.session.state,'SETTLED');assert.equal(observed.operation.state,'DONE');
assert.equal(observed.dispatch_attempts,1);assert.equal(observed.finished_dispatch_attempts,1);assert.equal(observed.receipt_count,1);
const bytes=Buffer.from(observed.receipt.body,'base64'),body=parseStrictJson(bytes) as any;
assert.deepEqual(Buffer.from(jcsBytes(body)),bytes);assert.equal(sha(bytes),observed.receipt.hash);
const receiptKey=Buffer.from(new PublicKey(control.manifest.receipt_public_key).toBytes());
const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),receiptKey]),format:'der',type:'spki'});
assert.ok(verify(null,Buffer.from(observed.receipt.hash,'hex'),key,Buffer.from(observed.receipt.signature,'base64')));
assert.equal(body.request_id,request);assert.equal(body.operation_id,operation);assert.equal(body.pool,control.manifest.pool);assert.equal(body.deployment_id,control.manifest.deployment_id);
assert.equal(body.billing_effect,'charge');assert.equal(body.evidence_kind,'PROXY_USAGE');assert.equal(body.reason,'metered');
const plan=read('config/provider-acceptance.i10.json');
const tariffs=plan.models.map((entry:any)=>entry.tariff).filter((tariff:any)=>tariff.tariff_hash===body.tariff_hash);assert.equal(tariffs.length,1);
const tariff=tariffs[0];assert.equal(tariff.provider,'openai');assert.equal(tariff.model,'gpt-4o-mini-2024-07-18');assert.equal(tariff.operator_fee_micro_usdc,'0');
const {tariff_hash:hash,...tariffBody}=tariff;assert.equal(sha(jcsBytes(tariffBody)),hash);
const units=new Map<string,bigint>();for(const entry of body.usage){assert.match(entry.count,/^(0|[1-9][0-9]*)$/);assert.ok(!units.has(entry.unit));units.set(entry.unit,BigInt(entry.count));}
assert.equal(units.size,tariff.rates.length);let nano=0n;
for(const rate of tariff.rates){assert.equal(rate.unit_denominator,'1');assert.ok(units.has(rate.unit));nano+=units.get(rate.unit)!*BigInt(rate.nano_usdc_numerator);}
assert.equal(nano.toString(),body.observed_nano_usdc);assert.equal(nano.toString(),body.charged_nano_usdc);assert.equal(nano.toString(),observed.operation.charged_nano);
assert.equal(body.operator_loss_nano_usdc,'0');assert.equal(observed.operation.operator_loss_nano,'0');assert.equal(((nano+999n)/1000n).toString(),observed.settlement.charge_micro);assert.equal(observed.settlement.signed,true);
assert.equal(observed.previous_dispatch_attempts,0);assert.equal(observed.previous_receipt.evidence_kind,'NOT_DISPATCHED');assert.equal(observed.previous_receipt.charge_nano,'0');
const budget=read('target/i10-provider-acceptance/budget-state.json'),before=read('target/i10-api-fix-before.json');
assert.deepEqual(budget.identity,before.budget.identity);assert.deepEqual(budget.reservations.slice(0,4),before.budget.reservations);assert.equal(budget.reservations.length,5);
const reservation=budget.reservations[4];assert.equal(reservation.case_id,'demo-'+operation);assert.equal(reservation.request_id,request);assert.equal(reservation.operation_id,operation);assert.equal(reservation.kind,'explicit_demo');assert.equal(reservation.template_case_id,'openai-chat-plain');assert.equal(reservation.max_cost_micro_usdc,'19277');
const reserved=budget.reservations.reduce((sum:bigint,row:any)=>sum+BigInt(row.max_cost_micro_usdc),0n);
const events=[];for(const line of readFileSync(`${directory}/control.stderr.log`,'utf8').split('\n')){let event;try{event=JSON.parse(line);}catch{continue;}if(event.event==='provider_dispatch'){assert.equal(event.stage,'complete');assert.equal(event.http_status,200);assert.equal(event.completed,true);assert.equal(event.timed_out,false);assert.ok(Number.isSafeInteger(event.elapsed_ms));events.push({event:event.event,http_status:event.http_status,stage:event.stage,elapsed_ms:event.elapsed_ms,completed:event.completed,timed_out:event.timed_out});}}
assert.equal(events.length,1);
const ui=read('target/i10-phantom-openai-success-observation.json');assert.equal(ui.state.session,null);assert.equal(ui.state.operation,null);assert.equal(ui.state.manifest_hash,control.manifest.manifest_hash);assert.equal(ui.state.balance_micro_usdc,(1000000n-BigInt(observed.settlement.charge_micro)).toString());assert.equal(ui.state.response_observation.operation_id,operation);
assert.ok(ui.state.verified_settlements.some((item:any)=>item.request_id===request&&item.charge_micro_usdc===observed.settlement.charge_micro&&item.receipt_ids.includes(body.receipt_id)));
const report={schema:1,collected_at_utc:new Date().toISOString(),fixture_only:false,request_id:request,operation_id:operation,
 session:observed.session,operation:observed.operation,
 counts:{committed_dispatch_attempts:observed.dispatch_attempts,finished_dispatch_attempts:observed.finished_dispatch_attempts,provider_evidence_rows:observed.provider_evidence,receipts:observed.receipt_count,provider_dispatch_diagnostics_current_log:events.length},
 receipt:{receipt_id:body.receipt_id,receipt_hash:observed.receipt.hash,signature_verified:true,canonical_digest_verified:true,request_operation_pool_deployment_binding_verified:true,evidence_kind:body.evidence_kind,reason:body.reason,billing_effect:body.billing_effect,tariff_hash:body.tariff_hash,model:tariff.model,usage:body.usage,observed_nano_usdc:body.observed_nano_usdc,charged_nano_usdc:body.charged_nano_usdc,operator_loss_nano_usdc:body.operator_loss_nano_usdc,fixed_integer_tariff_math_verified:true},
 settlement:{...observed.settlement,integer_micro_rounding_verified:true,successor_signature_cryptographically_verified_by_collector:false},
 ui_cross_check:{artifact:'target/i10-phantom-openai-success-observation.json',sha256:fileSha('target/i10-phantom-openai-success-observation.json'),journal_revision:ui.state.journal_revision,remaining_micro_usdc:ui.state.balance_micro_usdc,pending_session:null,verified_successor_source:'existing SDK verification reported by parent browser observation',response_observation:ui.state.response_observation},
 parent_budget:{identity:budget.identity,original_four_rows_unchanged:true,before_artifact:'target/i10-api-fix-before.json',reservation_count:budget.reservations.length,reserved_micro_usdc:reserved.toString(),remaining_micro_usdc:(BigInt(budget.identity.budget_micro_usdc)-reserved).toString(),new_explicit_demo_reservation:reservation,budget_file_sha256:fileSha('target/i10-provider-acceptance/budget-state.json')},
 previous_failure_preserved:{request_id:previousRequest,dispatch_attempts:observed.previous_dispatch_attempts,...observed.previous_receipt},
 provider_diagnostics:events,
 method:{database:'one SELECT snapshot with default_transaction_read_only=on and statement_timeout5000; no tokens, prompts, encrypted records or secret material read',receipt:'SHA256 of exact canonical public receipt body, Ed25519 verification using configured manifest receipt public key, exact operation/pool/deployment binding, integer frozen-tariff math',logs:'allowlisted provider_dispatch fields only; no raw log exported',collector_source:'target/i10-collect-openai-success.ts',collector_source_sha256:fileSha('target/i10-collect-openai-success.ts'),command:'target/i08-toolchain/bin/node target/i10-collect-openai-success.ts'},
 collector_actions:{provider_or_AUTH_requests:0,chain_sends:0,PG_mutations:0,config_budget_or_journal_mutations:0},
 limitations:['Provider dispatch count is the immutable ledger attempt count plus one completed diagnostic in the current process log, not independent packet capture.','The collector verifies the public receipt signature and tariff math; successor signature validation belongs to the existing browser SDK and is cross-checked through its safe public observation.','A successful new explicit demo request does not replay or change the earlier NOT_DISPATCHED case.','This report does not establish withdrawal, full I10, hosted CI, G3 as a whole or G1-G4.'],release_gates_passed:[]};
writeFileSync('target/i10-phantom-openai-success-runtime.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:true,receipt_id:body.receipt_id,dispatch_attempts:1,charge_micro_usdc:observed.settlement.charge_micro,remaining_micro_usdc:ui.state.balance_micro_usdc,budget_remaining_micro_usdc:report.parent_budget.remaining_micro_usdc}));
