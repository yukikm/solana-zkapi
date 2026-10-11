/** Native runtime for the Go localhost frontend. Start via clientd; secrets are
 * one JSON line on stdin, never command arguments/environment/log output. */
import { readFile, chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { address, createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, getBase64Encoder, partiallySignTransaction } from '@solana/kit';
import { parseStrictJson } from '@zkapi/solana-sdk/trust';
import { ControlClient, verifiedClientBundle, validateNoteJournal, apiOperationPath, type NoteJournal } from '@zkapi/solana-sdk/control';
import { NativeSessionVerifier } from '@zkapi/solana-sdk/control-node';
import { NativeJournalStore } from '@zkapi/solana-sdk/journal-node';
import { EncryptedJournal, importJournalKey } from '@zkapi/solana-sdk/journal';
import { unlockJournalKey, initializeJournalKey } from '@zkapi/solana-sdk/secret-custody';
import { relayFetch, writeNodeResponse, writeGatewayResponse } from '@zkapi/solana-sdk/clientd-network';
import type { HeaderPairs } from '@zkapi/solana-sdk/gateway';
import { ClientDaemon, DaemonConflict } from '@zkapi/solana-sdk/clientd-bridge';
import { NativeProver } from '@zkapi/solana-sdk/prover-node';
import { NoteProver } from '@zkapi/solana-sdk/prover';
import { SolanaWalletChain } from '@zkapi/solana-sdk/wallet-chain';
import { WalletClient, type WalletRoles } from '@zkapi/solana-sdk/wallet';
import { connectionTransport, createSolanaRpcWithFetch, type V0Wallet } from '@zkapi/solana-sdk/transport';

import { ConfigurationError, validateConfigurationCommand, validateRuntimeConfiguration } from './runtime-config.ts';
import { FrontendDelivery, gatewayDeliveryHeader, gatewayDeliveryPath } from './runtime-delivery.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--validate-config')) {
    try { process.stdout.write(JSON.stringify(await validateConfigurationCommand(args)) + '\n'); }
    catch (error) { const failure = error instanceof ConfigurationError ? error : new ConfigurationError('invalid_schema', 2);
      process.stderr.write(JSON.stringify({ schema: 1, error: { code: failure.code, ...(failure.field ? { field: failure.field } : {}) } }) + '\n'); process.exitCode = failure.status; }
    return;
  }
  const [configPath,socketPath,relaySocket] = args;
  if (args.length !== 3 || !configPath || !socketPath || !relaySocket) throw Error('missing runtime configuration');
  const lines = createInterface({input:process.stdin,crlfDelay:Infinity});
  const [line] = await once(lines,'line') as [string]; lines.close();
  // Go retains its write end after the secret handoff. Supervisor death closes
  // it even on SIGKILL; before startup completes SIGTERM exits, afterwards it
  // runs the same durable shutdown path as an ordinary daemon stop.
  process.stdin.once('end',()=>process.kill(process.pid,'SIGTERM'));
  process.stdin.resume();
  const secret = parseStrictJson(new TextEncoder().encode(line)) as unknown as {passphrase:string;wallet_seed_base64?:string;initialize_key?:boolean};
  const passphrase = new TextEncoder().encode(secret.passphrase); secret.passphrase='';
  const validated = await validateRuntimeConfiguration(parseStrictJson(new Uint8Array(await readFile(configPath))), { requireCustody: true });
  const { config: c, manifest: m, models, services, artifacts } = validated;
  // Complete offline trust/configuration checks before creating or unlocking custody.
  let raw: Uint8Array;
  try { raw = secret.initialize_key ? await initializeJournalKey(c.custody,passphrase) : await unlockJournalKey(c.custody,passphrase); }
  finally { passphrase.fill(0); }
  const key = await importJournalKey(raw); raw.fill(0);
  const fetcher=relayFetch(relaySocket), connection=createSolanaRpcWithFetch(c.rpc,fetcher);
  const observed=await connection.getAccountInfo(address(m.pool),{commitment:'finalized',encoding:'base64'}).send();
  if (!observed.value) throw Error('missing finalized pool');
  const a=observed.value,bundle=await verifiedClientBundle(m,await connection.getGenesisHash().send(),{address:m.pool,owner:a.owner,executable:a.executable,lamports:BigInt(a.lamports),data:new Uint8Array(getBase64Encoder().encode(a.data[0])),slot:BigInt(observed.context.slot),commitment:'finalized'},BigInt(observed.context.slot),artifacts);
  const prover=await NoteProver.create(m,bundle.artifacts,new NativeProver(c.prover.path,c.prover.sha256));
  const store=await NativeJournalStore.open(c.journal),journal=new EncryptedJournal<NoteJournal>(store,key,{deploymentId:m.deployment_id,pool:m.pool},validateNoteJournal);
  const client=new ControlClient({context:bundle.context,journal,verifier:new NativeSessionVerifier(c.verifier.path,c.verifier.sha256),fetch:fetcher,allowLoopbackHttp:m.deployment_environment==='local',directProviderBases:c.direct_provider_bases,oaVerifier:c.oa_verifier});
  const chain=new SolanaWalletChain(connection,m,c.indexer,{fetch:fetcher,allowLoopbackHttp:m.deployment_environment==='local',preparationCommitment:c.preparation_commitment});
  const wallets:V0Wallet[]=[];
  if(secret.wallet_seed_base64){
    const seed=Buffer.from(secret.wallet_seed_base64,'base64');
    try {
      if(seed.length!==32||seed.toString('base64')!==secret.wallet_seed_base64)throw Error('invalid wallet seed');
      secret.wallet_seed_base64='';
      const pair=await createKeyPairFromPrivateKeyBytes(seed);
      wallets.push({publicKey:await getAddressFromPublicKey(pair.publicKey),supportedTransactionVersions:new Set([0]),signTransaction:tx=>partiallySignTransaction([pair],tx)});
    } finally { seed.fill(0);secret.wallet_seed_base64=''; }
  }
  const rpc=connectionTransport(connection,{preparationCommitment:c.preparation_commitment});
  const wallet=new WalletClient({manifest:m,prover,journal,chain,rpc,wallets,fetch:fetcher});
  const service=new ClientDaemon({client,journal,noteId:c.note_id,mode:c.mode,models,services,gateway:c.gateway,keyReuseSeconds:c.key_reuse_seconds,settlementWaitMs:c.settlement_wait_ms,
    prepare:async(model,credentials)=>{
      const selected=models.find(configured=>configured.id===model);if(!selected)throw Error('model not configured');
      const current=await journal.read(c.note_id);if(!current?.value.witness)throw Error('full finalized note required');
      const snap=await chain.sessionSnapshot(current.value.witness.note_id,prover);
      const quote=await client.quote({mode:c.mode,provider:selected.provider,models:[c.mode==='proxy'?model:'*'],session_ttl_seconds:String(c.key_reuse_seconds===0?60:c.key_reuse_seconds??60)},selected.tariff);
      return{prepared:await prover.prepareSession(current.value.witness,current.value.state,snap.root,snap.siblings,quote,selected.tariff,credentials),root:snap.root};
    },
    prepareApi:async(api,credentials)=>{
      const selected=services.find(s=>apiOperationPath(s.tariff.api)===apiOperationPath(api));if(!selected)throw Error('API operation not configured');
      const current=await journal.read(c.note_id);if(!current?.value.witness)throw Error('full finalized note required');
      const snap=await chain.sessionSnapshot(current.value.witness.note_id,prover);
      const quote=await client.quoteApi(api,selected.tariff);
      return{prepared:await prover.prepareSession(current.value.witness,current.value.state,snap.root,snap.siblings,quote,selected.tariff,credentials),root:snap.root};
    },
    wallet:async(command:any)=>{if(!command||typeof command!=='object')throw Error('wallet command required');switch(command.action){case'deposit':await wallet.beginDeposit(c.note_id,command.amount,command.roles as WalletRoles);break;case'withdraw':await wallet.beginWithdrawal(c.note_id,command.mode,command.destination_owner,command.roles);break;case'escape':await wallet.fallbackToEscape(c.note_id);break;case'clear-unaccepted-auth':await wallet.reconcileUnacceptedAuthorization(c.note_id);break;case'emergency-escape':await wallet.beginEmergencyEscape(c.note_id,command.destination_owner,command.roles);break;case'reconcile-challenge':await wallet.reconcileChallengedEscape(c.note_id);break;case'finalize':await wallet.beginFinalize(c.note_id,command.roles);break;case'advance':return wallet.advance(c.note_id);case'prove':await wallet.resumeProof(c.note_id);break;case'recover-expired-setup':await wallet.reconcileExpiredCreation(c.note_id);break;case'retry-rejected':await wallet.retryRejected(c.note_id);break;default:throw Error('unsupported wallet action');}return{saved:true};},
  });
  await store.withLock(`daemon:${c.note_id}`,async()=>{
    // Missing notes are allowed solely for the management deposit workflow.
    // Remote session recovery can leave management available with inference
    // blocked. Trust, custody, finalized-chain and journal failures stay fatal.
    if(await journal.read(c.note_id))await service.start();
    const frontendDelivery = new FrontendDelivery();
    const server=createServer({maxHeaderSize:c.gateway?48*1024:16*1024},async(req,res)=>{const abort=new AbortController();const disconnected=()=>{if(!res.writableEnded)abort.abort();};res.on('close',disconnected);try{let length=0;const chunks:Buffer[]=[];for await(const chunk of req){length+=chunk.length;if(length>1024*1024)throw Error('size');chunks.push(chunk);}const headers=new Headers();for(const[name,value]of Object.entries(req.headers))if(value)headers.set(name,Array.isArray(value)?value.join(','):value);
      const target=req.url??'', path=target.split('?')[0];
      const gateway=c.gateway?.mounts.some(m=>m.prefix===''||path===m.prefix||path.startsWith(m.prefix+'/'))
        && !/^\/(?:admin|zkapi)(?:\/|$)/.test(path) && path!=='/v1/models';
      const body=new Uint8Array(Buffer.concat(chunks));
      if(target===gatewayDeliveryPath){
        const token=req.headers[gatewayDeliveryHeader];
        const accepted=req.method==='POST'&&body.length===0&&typeof token==='string'&&await frontendDelivery.acknowledge(token);
        res.writeHead(accepted?204:409);res.end();return;
      }
      // A native client can start its next turn immediately after outer EOF,
      // while the private frontend acknowledgement is still being persisted.
      // Waiting never clears the SDK hold, and management remains available.
      if(gateway||req.method==='POST'&&/^\/(?:v1\/|zkapi\/v1\/api\/)/.test(path))await frontendDelivery.waitForAcknowledgement(abort.signal);
      if(gateway){
        if(Object.keys(req.trailers).length)throw Error('request trailers forbidden');
        const rawPairs:HeaderPairs=[];for(let i=0;i<req.rawHeaders.length;i+=2)rawPairs.push([req.rawHeaders[i],Buffer.from(req.rawHeaders[i+1],'latin1').toString('base64')]);
        const result=await service.handleGateway(req.method??'',target,body,rawPairs,abort.signal);
        if(result instanceof Response)await writeNodeResponse(result,res);else {
          const delivery=frontendDelivery.register(async()=>{await result.confirmDelivery?.();});
          try {
            await writeGatewayResponse({...result,headers:[...result.headers,[gatewayDeliveryHeader,Buffer.from(delivery.token).toString('base64')]],confirmDelivery:undefined},res);
            delivery.finish(res.writableFinished);
          } catch(error) { delivery.finish(false);throw error; }
        }
      }else await writeNodeResponse(await service.handle(req.method??'',target,body,headers,abort.signal),res);
      if((await journal.read(c.note_id))?.value.wallet?.status==='active')await service.startIfNeeded();
    }catch(error){if(!res.headersSent){res.writeHead(error instanceof DaemonConflict?409:503,{'Content-Type':'application/json'});res.end('{"error":{"code":"recovery_required"}}');}else res.destroy();}finally{res.off('close',disconnected);}});
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});await chmod(socketPath,0o600);
    const timer=setInterval(()=>service.maintenance().catch(()=>{}),1000);timer.unref();
    process.stdout.write('READY\n');
    await new Promise<void>(resolve=>{let stopping=false;const stop=()=>{if(stopping)return;stopping=true;clearInterval(timer);const closed=new Promise<void>(done=>server.close(()=>done()));void Promise.all([closed,service.shutdown().catch(()=>{})]).then(()=>resolve());};process.once('SIGTERM',stop);process.once('SIGINT',stop);});
  });
}
main().catch(()=>{process.stderr.write('clientd runtime failed; durable journal retained\n');process.exitCode=1;}).finally(()=>process.stdin.destroy());
