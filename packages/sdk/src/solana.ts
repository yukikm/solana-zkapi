/** Native Kit values and codecs shared by the SDK. No implicit RPC or signing. */
import { address, createRpc, createSolanaRpcApi, DEFAULT_RPC_CONFIG, getAddressDecoder, getAddressEncoder,
  getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder, getSignatureFromTransaction, getTransactionDecoder,
  getTransactionEncoder, type Address, type Rpc, type RpcResponse, type RpcTransport,
  type SolanaRpcApi, type Transaction } from '@solana/kit';
import { parseJsonWithBigInts, stringifyJsonWithBigInts } from '@solana/rpc-spec-types';

export const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
export function addressBytes(value: Address): Uint8Array { return new Uint8Array(getAddressEncoder().encode(value)); }
export function addressFromBytes(value: Uint8Array): Address {
  if (value.length !== 32) throw new Error('expected 32 address bytes');
  return getAddressDecoder().decode(value);
}
export function encodeTransaction(value: Transaction): Uint8Array {
  const message = transactionMessage(value);
  const canonicalMessage = getCompiledTransactionMessageEncoder().encode(message);
  if (canonicalMessage.length !== value.messageBytes.length || canonicalMessage.some((byte,i)=>byte !== value.messageBytes[i])) throw new Error('noncanonical transaction message');
  const {numSignerAccounts,numReadonlySignerAccounts,numReadonlyNonSignerAccounts} = message.header;
  if (numSignerAccounts > message.staticAccounts.length || numReadonlySignerAccounts > numSignerAccounts
    || numReadonlyNonSignerAccounts > message.staticAccounts.length-numSignerAccounts) throw new Error('invalid transaction account header');
  const required = message.staticAccounts.slice(0,message.header.numSignerAccounts);
  if (new Set(message.staticAccounts).size !== message.staticAccounts.length || Object.keys(value.signatures).length !== required.length
    || required.some(key=>!Object.hasOwn(value.signatures,key))) throw new Error('incorrect signature map');
  const signatures = Object.fromEntries(required.map(key=>{
    const signature = value.signatures[key];
    if (signature !== null && (!(signature instanceof Uint8Array) || signature.length !== 64)) throw new Error('invalid signature bytes');
    return [key,signature];
  }));
  return new Uint8Array(getTransactionEncoder().encode({...value,signatures}));
}
export function decodeTransaction(value: Uint8Array): Transaction {
  const detached = new Uint8Array(value), transaction = getTransactionDecoder().decode(detached);
  const canonical = encodeTransaction(transaction);
  if (detached.length !== canonical.length || detached.some((byte,i)=>byte !== canonical[i])) throw new Error('noncanonical transaction wire');
  return transaction;
}
export function transactionMessage(value: Transaction) { return getCompiledTransactionMessageDecoder().decode(value.messageBytes); }
export function transactionBlockhash(value: Transaction): string { return transactionMessage(value).lifetimeToken; }
export function transactionSignature(value: Transaction): string { return getSignatureFromTransaction(value); }

/** Preserve the host's bounded fetch/egress policy. Each invocation sends once;
 * lossless Kit JSON codecs retain u64 RPC values before explicit range checks. */
export function createSolanaRpcWithFetch(url: string, fetcher: typeof fetch): Rpc<SolanaRpcApi> {
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('invalid RPC URL');
  const transport: RpcTransport = async <T>({payload,signal}: {payload: unknown; signal?: AbortSignal}): Promise<RpcResponse<T>> => {
    const response = await fetcher(endpoint.toString(), {method:'POST',headers:{'content-type':'application/json'},body:stringifyJsonWithBigInts(payload),signal});
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    return parseJsonWithBigInts(await response.text()) as RpcResponse<T>;
  };
  // Kit omits the server's finalized default from the JSON request. Preserve
  // the caller's explicit commitment for bounded relays which inspect it.
  const nativeApi = createSolanaRpcApi(DEFAULT_RPC_CONFIG);
  const api = new Proxy(nativeApi, {get(target, property, receiver) {
    const method = Reflect.get(target,property,receiver);
    if (typeof method !== 'function') return method;
    return (...params: unknown[]) => {
      const plan = method(...params);
      const explicit = params.flatMap((value,index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        return ['commitment','preflightCommitment'].filter(key=>Object.hasOwn(value,key)).map(key=>({index,key,value:(value as Record<string,unknown>)[key]}));
      });
      return {execute: ({signal,transport:send}: {signal?:AbortSignal;transport:RpcTransport})=>plan.execute({signal,transport:async <T>(config:{payload:unknown;signal?:AbortSignal})=>{
        const payload = config.payload as {params: unknown[]};
        const restored = [...payload.params];
        for (const item of explicit) restored[item.index] = {...(restored[item.index] as object|undefined),[item.key]:item.value};
        return send<T>({...config,payload:{...payload,params:restored}});
      }})};
    };
  }});
  return createRpc({api,transport});
}
