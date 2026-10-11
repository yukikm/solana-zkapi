/** Synthetic, in-memory provider for actual CLI gateway acceptance. */
import assert from 'node:assert/strict';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export type NativeAgentCase = 'text'|'tool'|'subsequent_turn'|'capability400'|'capability422'|'rate_limit429'|'unavailable503'|'lost_headers'|'truncated'|'idle_timeout'|'cancel'|'fallback';
export type NativeAgentKind = 'codex'|'claude';
export function nativeAgentFixture(kind: NativeAgentKind, calls: Record<string,number>) {
  let active:NativeAgentCase='text', workdir='', ordinal=0, observedResolve=()=>{}, releaseResolve=()=>{};
  let observed=Promise.resolve(), released=Promise.resolve();
  const requests:{case:NativeAgentCase;bodySha256:string;target:string;headerNames:string[]}[]=[];
  const model=kind==='codex'?'gpt-5.4':'claude-sonnet-4-20250514';
  const textMarker=kind==='codex'?'CODEX_TEXT_FIXTURE_OK':'CLAUDE_CODE_FIXTURE_OK';
  const toolMarker=kind==='codex'?'CODEX_TOOL_FIXTURE_OK':'CLAUDE_CODE_TOOL_FIXTURE_OK';
  const event=(type:string,value:Record<string,unknown>)=>`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`;
  const responseEvents=(body:any,tool:boolean)=>{
    const id='resp_fixture_'+ordinal, message={id:'msg_fixture_'+ordinal,type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:active==='tool'?toolMarker:textMarker,annotations:[]}]};
    const toolName=body.tools?.find((t:any)=>t.type==='function'&&['exec_command','shell_command'].includes(t.name))?.name;
    if(tool)assert.ok(toolName,'Codex local command tool');
    const call={id:'fc_fixture',type:'function_call',status:'completed',call_id:'call_fixture',name:toolName,arguments:JSON.stringify(toolName==='exec_command'?{cmd:'cat probe.txt',workdir,yield_time_ms:1000,max_output_tokens:1000}:{command:'cat probe.txt',workdir,timeout_ms:1000})};
    const output=tool?call:message;
    const response={id,object:'response',created_at:100,model,status:'in_progress',output:[],error:null};
    let sequence=0;const emit=(type:string,data:any)=>event(type,{sequence_number:sequence++,...data});
    let bytes=emit('response.created',{response})+emit('response.output_item.added',{response_id:id,output_index:0,item:tool?{...call,arguments:''}:{...message,content:[]}});
    if(tool)bytes+=emit('response.function_call_arguments.delta',{response_id:id,item_id:call.id,output_index:0,delta:call.arguments})+emit('response.function_call_arguments.done',{response_id:id,item_id:call.id,output_index:0,arguments:call.arguments});
    else bytes+=emit('response.content_part.added',{response_id:id,item_id:message.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}})+emit('response.output_text.delta',{response_id:id,item_id:message.id,output_index:0,content_index:0,delta:message.content[0].text})+emit('response.output_text.done',{response_id:id,item_id:message.id,output_index:0,content_index:0,text:message.content[0].text});
    return bytes+emit('response.output_item.done',{response_id:id,output_index:0,item:output})+emit('response.completed',{response:{...response,status:'completed',output:[output],service_tier:'default',usage:{input_tokens:1,input_tokens_details:{cached_tokens:0},output_tokens:1,output_tokens_details:{reasoning_tokens:0},total_tokens:2}}});
  };
  const messageStart=()=>event('message_start',{message:{id:'msg_fixture_'+ordinal,type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,service_tier:'standard',usage:{input_tokens:1,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0,cache_creation:{ephemeral_5m_input_tokens:0,ephemeral_1h_input_tokens:0}}}});
  const messageEvents=(tool:boolean)=>messageStart()+(tool?
    event('content_block_start',{index:0,content_block:{type:'tool_use',id:'toolu_fixture',name:'Read',input:{}}})+event('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({file_path:join(workdir,'probe.txt')})}}):
    event('content_block_start',{index:0,content_block:{type:'text',text:''}})+event('content_block_delta',{index:0,delta:{type:'text_delta',text:active==='tool'?toolMarker:textMarker}}))+
    event('content_block_stop',{index:0})+event('message_delta',{delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:1}})+event('message_stop',{});
  return {
    kind,requests,
    setCase(name:NativeAgentCase,directory:string){releaseResolve();active=name;workdir=directory;ordinal=0;observed=new Promise<void>(resolve=>observedResolve=resolve);released=new Promise<void>(resolve=>releaseResolve=resolve);},
    observed:()=>observed,
    release:()=>releaseResolve(),
    async handle(req:IncomingMessage,res:ServerResponse,body:any,raw:Uint8Array){
      // Count arrival before validating shape so changed-body retries (including
      // a stream:false fallback) cannot disappear from the egress evidence.
      requests.push({case:active,bodySha256:createHash('sha256').update(raw).digest('hex'),target:req.url!,headerNames:Object.keys(req.headers).sort()});
      calls[active]=(calls[active]??0)+1;ordinal++;
      const path=new URL(req.url!,'http://127.0.0.1').pathname;
      assert.equal(path,kind==='codex'?'/v1/responses':'/v1/messages');
      assert.equal(req.method,'POST');assert.equal(req.headers.authorization,'Bearer general-api-fixture-credential');
      assert.equal(body.model,model);assert.equal(body.stream,true);
      assert.equal(body.previous_response_id,undefined);assert.equal(body.conversation,undefined);
      if(kind==='codex')assert.equal(body.store,false);
      assert.ok(ordinal<=(['tool','subsequent_turn'].includes(active)?2:1),'native provider request replay');
      if(active==='subsequent_turn'&&ordinal===2){const history=kind==='codex'?body.input:body.messages;assert.ok(Array.isArray(history));assert.ok(history.some((item:any)=>item.role==='assistant'),'subsequent turn carries local conversation');}
      const tool=active==='tool'&&ordinal===1;
      if(active==='tool'&&ordinal===2){const history=kind==='codex'?body.input:body.messages;assert.ok(JSON.stringify(history).includes(toolMarker),'local tool output must survive continuation');}
      observedResolve();
      const errorStatus:Partial<Record<NativeAgentCase,number>>={capability400:400,capability422:422,rate_limit429:429,unavailable503:503};
      if(errorStatus[active]){
        // These strings deliberately exercise capability-specific retry logic
        // in the pinned native clients, beyond their HTTP retry count setting.
        const message=active==='capability400'?(kind==='claude'?'thinking.type: enabled is not supported':'Unsupported parameter: reasoning.effort'):
          active==='capability422'?'output_config.effort: extra inputs are not permitted':'Native gateway synthetic failure';
        const type=active.startsWith('capability')?'invalid_request_error':active==='rate_limit429'?'rate_limit_error':'api_error';
        res.writeHead(errorStatus[active]!,{'Content-Type':'application/json'});
        res.end(JSON.stringify(kind==='codex'?{error:{type,message}}:{type:'error',error:{type,message}}));return;
      }
      if(active==='lost_headers'){res.destroy();return;}
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});
      const start=kind==='codex'?event('response.created',{response:{id:'resp_fault',object:'response',model,status:'in_progress',output:[]}}):messageStart();
      if(['truncated','idle_timeout','cancel','fallback'].includes(active)){
        res.write(start);
        if(active==='truncated'){setImmediate(()=>res.destroy());return;}
        // Claude's pinned fallback trigger is a clean stream that started a
        // message but never completed a content block. Codex likewise has no
        // terminal response event. Neither client may resend this invocation.
        if(active==='fallback'){res.end();return;}
        await Promise.race([released,new Promise<void>(resolve=>res.once('close',resolve))]);
        if(!res.destroyed)res.destroy();return;
      }
      res.end(kind==='codex'?responseEvents(body,tool):messageEvents(tool));
    },
  };
}
