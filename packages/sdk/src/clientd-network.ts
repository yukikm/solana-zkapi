/** Go's private Unix relay is the only network transport used by clientd.
 * It applies one explicit direct/Tor policy to control, provider, indexer and RPC. */
import { request, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { isAbsolute } from 'node:path';
import type { GatewayResponse } from './gateway.ts';

export function relayFetch(socketPath: string): typeof fetch {
  if (!isAbsolute(socketPath)) throw new Error('private relay socket required');
  return async (input, init = {}) => {
    if (input instanceof Request) throw new Error('explicit relay URL and options required');
    const url = new URL(String(input));
    if (url.username || url.password || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('invalid relay destination');
    const headers = new Headers(init.headers); headers.set('X-Zkapi-Target', url.href);
    if (init.body !== undefined && init.body !== null && typeof init.body !== 'string' && !(init.body instanceof Uint8Array)) throw new Error('bounded relay request body required');
    const body = init.body == null ? undefined : typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.from(init.body as Uint8Array);
    if (body && body.length > 4*1024*1024) throw new Error('relay body limit');
    if (body) headers.set('Content-Length', String(body.length));
    return new Promise<Response>((resolve, reject) => {
      const headerMap: Record<string,string> = {}; headers.forEach((v,k)=>{headerMap[k]=v;});
      const req = request({ socketPath, path: '/fetch', method: init.method ?? 'GET', headers: headerMap, signal: init.signal ?? undefined }, incoming => {
        const responseHeaders = new Headers();
        for (const [name,value] of Object.entries(incoming.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        const status = incoming.statusCode!;
        if (status >= 300 && status < 400) { incoming.destroy(); reject(new Error('relay redirect rejected')); return; }
        const stream = [204,205,304].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        if (!stream) incoming.resume();
        resolve(new Response(stream, { status, headers: responseHeaders }));
      });
      req.once('error', () => reject(new Error('network unavailable; operation retained for recovery')));
      req.end(body);
    });
  };
}

/** HTTP disconnect cancels the ONE delivered stream and runs the shared client's
 * finalizer (including reuse-zero close). It never starts another inference. */
export async function writeNodeResponse(result: Response, response: ServerResponse): Promise<void> {
  // A downstream disconnect can precede upstream headers. Its close event has
  // already fired, so attaching a listener alone would leak the response stream.
  if(response.destroyed){await result.body?.cancel();return;}
  result.headers.forEach((value,key)=>response.setHeader(key,value));response.writeHead(result.status);
  const reader=result.body?.getReader();if(!reader){response.end();return;}
  let canceled=false, canceling:Promise<void>|undefined;
  const cancel=()=>{if(!response.writableEnded){canceled=true;canceling??=reader.cancel().catch(()=>{});}};
  response.on('close',cancel);
  try {
    while(!canceled){const next=await reader.read();if(next.done)break;
      if(response.destroyed){canceled=true;await (canceling??=reader.cancel().catch(()=>{}));break;}
      if(!response.write(next.value))await new Promise<void>(resolve=>{const done=()=>{response.off('drain',done);response.off('close',done);resolve();};response.once('drain',done);response.once('close',done);});
    }
    if(!canceled)response.end();
  } finally {response.off('close',cancel);if(canceled)await (canceling??=reader.cancel().catch(()=>{}));}
}

/** Lossless native gateway response; repeated fields never pass through Headers. */
export async function writeGatewayResponse(result: GatewayResponse, response: ServerResponse): Promise<void> {
  if(response.destroyed){await result.body.cancel();return;}
  const headers=result.headers.filter(([name])=>name!=='cache-control').flatMap(([name,value])=>[name,Buffer.from(value,'base64').toString('latin1')]);
  headers.push('cache-control','no-store');if(result.trailerNames.length)headers.push('trailer',result.trailerNames.join(', '));let sentHeaders=false;
  const sendHeaders=()=>{if(!sentHeaders){response.writeHead(result.status,headers);sentHeaders=true;}};
  const reader=result.body.getReader();let canceled=false,canceling:Promise<void>|undefined;
  const cancel=()=>{if(!response.writableEnded){canceled=true;canceling??=reader.cancel().catch(()=>{});}};
  response.on('close',cancel);
  try {
    while(!canceled){const next=await reader.read();if(next.done)break;if(response.destroyed){cancel();break;}
      sendHeaders();if(!response.write(next.value))await new Promise<void>(resolve=>{const done=()=>{response.off('drain',done);response.off('close',done);resolve();};response.once('drain',done);response.once('close',done);});
    }
    if(!canceled){const trailers=await result.trailers;await result.completed;sendHeaders();if(trailers.length)response.addTrailers(trailers.map(([name,value]):[string,string]=>[name,Buffer.from(value,'base64').toString('latin1')]));await new Promise<void>((resolve,reject)=>{const finish=()=>{response.off('close',closed);resolve();};const closed=()=>{response.off('finish',finish);reject(Error('native gateway response interrupted'));};response.once('finish',finish);response.once('close',closed);response.end();});await result.confirmDelivery?.();}
  } catch(error){response.destroy();throw error;}
  finally {response.off('close',cancel);if(canceled)await(canceling??=reader.cancel().catch(()=>{}));}
}
