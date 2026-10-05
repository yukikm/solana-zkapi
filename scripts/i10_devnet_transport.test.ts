/** Actual local HTTP/TLS sockets, no public endpoint, provider credential or wallet key. */
import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';
import {createServer as tlsServer} from 'node:https';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {startDevnetFrontend,createDevnetPinnedFetch} from './i10_devnet_transport.ts';
const origin = (server: {address(): unknown}, scheme = 'https') => `${scheme}://127.0.0.1:${(server.address() as {port:number}).port}`;
async function listen(server: ReturnType<typeof httpServer>) { server.listen(0,'127.0.0.1'); await once(server,'listening'); return server; }
function cleanup(t: TestContext, server: ReturnType<typeof httpServer>) { t.after(() => new Promise<void>(resolve => {server.closeAllConnections();server.close(()=>resolve());})); }
async function certificate(t: TestContext) {
 const dir=await mkdtemp(join(tmpdir(),'zkapi-transport-tls-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 return {certificate:await readFile(join(dir,'cert.pem')),key:await readFile(join(dir,'key.pem'))};
}
test('TLS inference bridge streams first SSE frame before final usage, pins Host and preserves operation/Anthropic headers', {timeout:15_000}, async t=>{
 const cert=await certificate(t), seen:any[]=[];
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});t.after(()=>release());
 const upstream=await listen(httpServer(async(req,res)=>{const parts=[];for await(const chunk of req)parts.push(chunk);seen.push({host:req.headers.host,headers:req.headers,body:Buffer.concat(parts).toString(),path:req.url});
  res.writeHead(200,{'content-type':'text/event-stream','x-zkapi-operation-id':'operation-fixture','x-zkapi-status-url':'/zkapi/v1/sessions/fixture/operations/fixture'});
  res.write('event: content_block_delta\ndata: {"delta":"first"}\n\n');await gate;res.end('event: message_stop\ndata: {"usage":1}\n\n');}));cleanup(t,upstream);
 const authority='https://127.0.0.1:19486';
 const frontend=await startDevnetFrontend({...cert,port:0,upstreamOrigin:origin(upstream,'http'),kind:'inference',inferenceApiOrigin:authority});cleanup(t,frontend);
 const base=origin(frontend),fetcher=createDevnetPinnedFetch({ca:cert.certificate,indexerOrigin:'https://127.0.0.1:1',inferenceOrigin:base});
 const result=await fetcher(base+'/v1/messages',{method:'POST',headers:{host:'attacker.invalid',authorization:'Bearer fixture-token','idempotency-key':'fixture-idempotency','anthropic-version':'2023-06-01','content-type':'application/json'},body:'{"fixture":true}',signal:AbortSignal.timeout(5000)});
 assert.equal(result.status,200);assert.equal(result.headers.get('x-zkapi-operation-id'),'operation-fixture');assert.equal(result.headers.get('x-zkapi-status-url'),'/zkapi/v1/sessions/fixture/operations/fixture');
 const reader=result.body!.getReader(),first=await reader.read();assert.equal(first.done,false);assert.ok(new TextDecoder().decode(first.value).includes('"first"'));assert.ok(!new TextDecoder().decode(first.value).includes('"usage"'));
 assert.equal(seen.length,1);assert.equal(seen[0].host,new URL(authority).host);assert.equal(seen[0].headers['idempotency-key'],'fixture-idempotency');assert.equal(seen[0].headers['anthropic-version'],'2023-06-01');assert.equal(seen[0].headers.authorization,'Bearer fixture-token');assert.equal(seen[0].body,'{"fixture":true}');
 release();let tail='';for(;;){const next=await reader.read();if(next.done)break;tail+=new TextDecoder().decode(next.value);}assert.ok(tail.includes('"usage":1'));assert.equal(seen.length,1);
});
test('legacy indexer/control routes retain bodies/status, local errors do not retry, cancellation closes upstream', {timeout:15_000}, async t=>{
 const cert=await certificate(t),hits:Record<string,number>={};let disconnected!:()=>void;const disconnect=new Promise<void>(r=>{disconnected=r;});
 const upstream=await listen(httpServer(async(req,res)=>{const path=req.url!;hits[path]=(hits[path]??0)+1;if(path==='/v1/chat/completions'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: first\n\n');res.on('close',disconnected);return;}
  if(path==='/zkapi/v1/sessions/error'){res.writeHead(503,{'content-type':'application/json','x-zkapi-error-code':'operation_unavailable'});res.end('{"error":"fixture"}');return;}
  if(path==='/zkapi/v1/sessions/lost'){req.socket.destroy();return;}
  const body=[];for await(const chunk of req)body.push(chunk);res.writeHead(200,{'content-type':'application/json'});res.end(path.endsWith('clearance')?Buffer.concat(body):'{"root":"fixture"}');}));cleanup(t,upstream);
 const indexer=await startDevnetFrontend({...cert,port:0,upstreamOrigin:origin(upstream,'http'),kind:'indexer'});cleanup(t,indexer);
 const control=await startDevnetFrontend({...cert,port:0,upstreamOrigin:origin(upstream,'http'),kind:'control'});cleanup(t,control);
 const inference=await startDevnetFrontend({...cert,port:0,upstreamOrigin:origin(upstream,'http'),kind:'inference',inferenceApiOrigin:'https://127.0.0.1:19486'});cleanup(t,inference);
 let status:number|undefined;const f=createDevnetPinnedFetch({ca:cert.certificate,indexerOrigin:origin(indexer),controlOrigin:origin(control),inferenceOrigin:origin(inference),onClearanceStatus:s=>{status=s;}});
 assert.deepEqual(await(await f(origin(indexer)+'/zkapi/v1/tree/root')).json(),{root:'fixture'});
 const receipts='/zkapi/v1/sessions/12345678-1234-4234-8234-123456789abc/receipts';
 // A nonempty SDK receipts page is followed by exactly this positive cursor URL.
 const cursorReply=await f(origin(control)+receipts+'?cursor=7');assert.equal(cursorReply.status,200);await cursorReply.arrayBuffer();assert.equal(hits[receipts+'?cursor=7'],1);
 for(const query of ['cursor=0','cursor=07','cursor=-1','cursor=1&url=https://elsewhere.invalid','cursor=9223372036854775808','cursor=%37','other=7'])await assert.rejects(f(origin(control)+receipts+'?'+query),/pinned service transport/);
 await assert.rejects(f(origin(control)+receipts+'?cursor=7',{method:'POST',body:'{}'}),/pinned service transport/);
 await assert.rejects(f(origin(control)+'/zkapi/v1/sessions/fixture/receipts?cursor=7'),/pinned service transport/);
 await assert.rejects(f(origin(inference)+'/v1/chat/completions?cursor=7',{method:'POST',body:'{}'}),/pinned service transport/);

 assert.deepEqual(await(await f(origin(control)+'/zkapi/v1/withdraw/clearance',{method:'POST',body:'{"nullifier":"fixture"}'})).json(),{nullifier:'fixture'});assert.equal(status,200);
 const unavailable=await f(origin(control)+'/zkapi/v1/sessions/error');assert.equal(unavailable.status,503);assert.equal(unavailable.headers.get('x-zkapi-error-code'),'operation_unavailable');await unavailable.arrayBuffer();assert.equal(hits['/zkapi/v1/sessions/error'],1);
 const lost=await f(origin(control)+'/zkapi/v1/sessions/lost');assert.equal(lost.status,503);assert.deepEqual(await lost.json(),{});assert.equal(hits['/zkapi/v1/sessions/lost'],1);
 const stream=await f(origin(inference)+'/v1/chat/completions',{method:'POST',body:'{}'});const reader=stream.body!.getReader();assert.equal((await reader.read()).done,false);await reader.cancel();await Promise.race([disconnect,delay(3000).then(()=>{throw Error('upstream did not close');})]);assert.equal(hits['/v1/chat/completions'],1);
 await assert.rejects(f(origin(indexer)+'/zkapi/v1/tree/root?url=https://elsewhere.invalid'),/pinned service transport/);
 await assert.rejects(f(origin(inference)+'/v1/unknown',{method:'POST',body:'{}'}),/pinned service transport/);
});
test('direct transport permits only exact HTTPS chat endpoint, refuses redirects and never retries TLS failure', {timeout:15_000}, async t=>{
 const cert=await certificate(t);let handshakes=0,requests=0;
 const direct=await listen(tlsServer({cert:cert.certificate,key:cert.key},(_req,res)=>{requests++;res.writeHead(302,{location:'https://elsewhere.invalid/chat/completions'});res.end();}));cleanup(t,direct);direct.on('tlsClientError',()=>handshakes++);
 const endpoint=origin(direct)+'/api/v1/chat/completions',f=createDevnetPinnedFetch({ca:cert.certificate,indexerOrigin:'https://127.0.0.1:1',directChatEndpoints:[endpoint]});
 for(const target of [endpoint+'?new=1',endpoint+'/extra',origin(direct)+'/v1/chat/completions',endpoint.replace('https:','http:')])await assert.rejects(f(target,{method:'POST',body:'{}'}),/pinned service transport/);
 assert.equal(handshakes,0);assert.equal(requests,0);
 // Direct requests use ordinary system TLS trust, never the loopback CA supplied
 // for local SDK services. A self-signed direct provider fails once, closed.
 await assert.rejects(f(endpoint,{method:'POST',body:'{}'}),/pinned service transport/);await delay(100);assert.equal(handshakes,1);assert.equal(requests,0);
 // A pinned local response redirect is also returned as a generic error, not followed.
 const local=createDevnetPinnedFetch({ca:cert.certificate,indexerOrigin:origin(direct)});await assert.rejects(local(origin(direct)+'/zkapi/v1/tree/root'),/redirect refused/);assert.equal(requests,1);
});
test('OA verifier transport permits only its pinned POST and never trusts the devnet service CA', {timeout:15_000}, async t=>{
 const cert=await certificate(t);let handshakes=0,requests=0;
 const verifier=await listen(tlsServer({cert:cert.certificate,key:cert.key},(_req,res)=>{requests++;res.end('{"status":"verified"}');}));cleanup(t,verifier);verifier.on('tlsClientError',()=>handshakes++);
 const endpoint=origin(verifier)+'/api/submit_key';
 const options={ca:cert.certificate,indexerOrigin:'https://127.0.0.1:1',oaVerifierEndpoints:[endpoint]},f=createDevnetPinnedFetch(options);
 // Caller mutation cannot expand the independent endpoint allowlist.
 options.oaVerifierEndpoints.push(origin(verifier)+'/other/submit_key');
 for(const target of [endpoint+'?new=1',endpoint+'?',endpoint+'#',endpoint+'/extra',origin(verifier)+'/other/submit_key',endpoint.replace('https:','http:')])await assert.rejects(f(target,{method:'POST',body:'{}'}),/pinned service transport/);
 await assert.rejects(f(endpoint),/pinned service transport/);assert.equal(handshakes,0);assert.equal(requests,0);
 await assert.rejects(f(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),/pinned service transport/);
 await delay(100);assert.equal(handshakes,1);assert.equal(requests,0);
 for(const invalid of [endpoint+'?',endpoint+'#',endpoint.replace('/submit_key','/chat/completions'),endpoint.replace('https:','http:')])assert.throws(()=>createDevnetPinnedFetch({...options,oaVerifierEndpoints:[invalid]}),/pinned service transport/);
});
