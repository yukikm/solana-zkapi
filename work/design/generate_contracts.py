import base64
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/contracts'
def ref(name): return {'$ref': '#/components/schemas/' + name}
def obj(properties, required=None, extra=False):
    return {'type': 'object', 'properties': properties,
            'required': list(properties) if required is None else required,
            'additionalProperties': extra}
def array(item, **kw): return {'type': 'array', 'items': item, **kw}
S = {'type': 'string'}
B = {'type': 'boolean'}
U = {'type': 'string', 'pattern': '^(0|[1-9][0-9]*)$', 'description': 'Unsigned integer decimal string; enforce semantic bounds in specs.'}
H = {'type': 'string', 'pattern': '^[0-9a-f]{64}$'}
F = {'type': 'string', 'pattern': '^0x[0-9a-f]{64}$', 'description': 'Canonical BN254 Fr; reject >= r.'}
P = {'type': 'string', 'pattern': '^[1-9A-HJ-NP-Za-km-z]{32,44}$', 'description': 'Base58 decoding must yield exactly 32 bytes.'}
ID = {'type': 'string', 'format': 'uuid', 'pattern': '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'}
MODE = {'type': 'string', 'enum': ['proxy', 'direct_openrouter', 'direct_oa']}
PROVIDER = {'type': 'string', 'enum': ['openai', 'anthropic', 'openrouter', 'oa']}
sch = {'UInt': U, 'Hash': H, 'Field': F, 'Pubkey': P, 'RequestId': ID,
       'Mode': MODE, 'Provider': PROVIDER}
sch['Point'] = obj({'x': F, 'y': F})
sch['SchnorrSignature'] = obj({'r_x': F, 'r_y': F, 's': F})
sch['Proof'] = obj({'backend': {'const': 'groth16_bn254', 'type': 'string'},
    'proof': {'type': 'string', 'contentEncoding': 'base64', 'minLength': 344,
              'maxLength': 344, 'description': 'Strict RFC4648 base64, exactly 256 decoded bytes.'}})
sch['RequestInputs'] = array(F, minItems=12, maxItems=12)
sch['Error'] = obj({'error': obj({'code': S, 'message': S, 'retriable': B,
    'request_id': {'type': ['string','null']}, 'retry_after_seconds': U, 'latest_root': F},
    ['code','message','retriable'])})
sch['QuoteRequest'] = obj({'mode': MODE, 'provider': PROVIDER,
    'models': array(S, minItems=1, maxItems=32, uniqueItems=True),
    'session_ttl_seconds': U},['mode','provider','models'])
sch['QuoteBody'] = obj({'quote_id': ID, 'deployment_id': S, 'pool': P, 'mode': MODE,
    'provider': PROVIDER, 'models': array(S,minItems=1,uniqueItems=True), 'tariff_hash': H,
    'cap_micro_usdc': U, 'issued_at': U, 'expires_at': U, 'session_ttl_seconds': U,
    'max_concurrency': U, 'control_api_origin': {'type':'string','format':'uri'},
    'inference_api_origin': {'type':'string','format':'uri'}})
sch['Quote'] = obj({'body': ref('QuoteBody'), 'quote_hash': H,
    'signature': {'type':'string','contentEncoding':'base64','description':'64-byte Ed25519 signature over raw quote hash.'}})
sch['Authorization'] = obj({'version': {'type':'string','const':'1'},
    'deployment_id': S, 'pool': P, 'request_id': ID, 'quote_hash': H, 'mode': MODE,
    'control_secret_hash': H, 'proxy_secret_hash': {'anyOf':[H,{'type':'null'}]}})
sch['SessionCreate'] = obj({'authorization': ref('Authorization'), 'quote': ref('Quote'),
    'public_inputs': ref('RequestInputs'), 'proof': ref('Proof')})
sch['Settlement'] = obj({'charge_micro_usdc': U, 'next_commitment': ref('Point'),
    'next_anchor': F, 'blind_delta_srv': F, 'next_state_signature': ref('SchnorrSignature')})
session_props = {'request_id': ID, 'mode': MODE,
    'state': {'type':'string','enum':['RESERVED','ISSUING','ISSUANCE_UNKNOWN','ACTIVE',
        'DRAINING','RECONCILING','SIGN_PENDING','SETTLED']},
    'cap_micro_usdc': U, 'issued_at': U, 'expires_at': U,
    'settlement': ref('Settlement'), 'provider_key': S, 'provider_api_origin': S,
    'last_error_code': S}
sch['SessionCreated'] = obj(session_props, ['request_id','mode','state','cap_micro_usdc'])
sch['SessionStatus'] = obj({k:v for k,v in session_props.items() if k != 'provider_key'},
    ['request_id','mode','state','cap_micro_usdc'])
sch['OperationStatus'] = obj({'operation_id': ID, 'request_id': ID,
    'state': {'type':'string','enum':['RESERVED','DISPATCHING','STREAMING','USAGE_UNKNOWN',
        'METERED','DONE','WAIVED_OPERATOR_LOSS']}, 'charged_nano_usdc': U,
    'usage': obj({},[],True), 'tariff_hash': H, 'response_replayable': {'type':'boolean','const':False}},
    ['operation_id','request_id','state','response_replayable'])
sch['ClearanceRequest'] = obj({'nullifier': F})
sch['ClearanceResponse'] = obj({'nullifier': F, 'signature': ref('SchnorrSignature')})
sch['Health'] = obj({'status': {'type':'string','enum':['ok','degraded']}, 'accepting':B})
sch['NullifierStatus'] = obj({'nullifier':F,'state':{'type':'string','enum':[
    'unused','authorized','cleared','exit_consumed','unknown']}})
sch['DashboardSummary'] = obj({'active_sessions':U,'pending_settlements':U,
    'charged_micro_usdc':U,'root_lag_slots':U,'unknown_operations':U})
sch['DashboardEvent'] = obj({'timestamp':U,'kind':S,'request_id':ID,
    'state':S,'charge_micro_usdc':U},['timestamp','kind','state'])
sch['DashboardEvents'] = obj({'events':array(ref('DashboardEvent')),'next_cursor':{'type':['string','null']}})
sch['Manifest'] = obj({'deployment_id':S,'manifest_hash':H,'genesis_hash':P,'program_id':P,
    'pool':P,'mint':P,'token_program':P,'decimals':{'type':'integer','const':6},
    'vault_binding':F,'state_key':ref('Point'),'clearance_key':ref('Point'),
    'quote_public_key':P,'circuit_id':S,'tree_backend':{'type':'string','enum':['sbf_poseidon','transition_proof']},
    'request_pk_hash':H,'request_vk_hash':H,'withdrawal_pk_hash':H,'withdrawal_vk_hash':H,
    'cap_micro_usdc':U,'note_ttl_seconds':U,'challenge_seconds':U,
    'control_api_origin':S,'inference_api_origin':S,'manifest_signature':S,
    'idl_hash':H,'api_endpoints':array(S),'tariff_hashes':array(H),
    'artifact_digests':{'type':'object','additionalProperties':H},'db_schema_version':U,
    'proving_keys_base_url':{'type':'string','format':'uri'},
    'tree_proof_artifacts':{'anyOf':[obj({'pk_hash':H,'vk_hash':H}),{'type':'null'}]}})
sch['CatalogEntry'] = obj({'model':S,'provider':PROVIDER,'modes':array(MODE),
    'endpoints':array(S),'modalities':array(S),'tariff_hash':H})
sch['Catalog'] = obj({'models':array(ref('CatalogEntry'))})
sch['TariffRate'] = obj({'unit':S,'nano_usdc_numerator':U,'unit_denominator':U})
sch['Tariff'] = obj({'tariff_hash':H,'version':U,'provider':PROVIDER,'model':S,
    'pricing_basis':{'type':'string','enum':['provider_reported_usd','fixed_usage_rates']},
    'valid_from':U,'valid_until':U,'rates':array(ref('TariffRate')),
    'operator_fee_micro_usdc':{'type':'string','const':'0'}})
sch['Root'] = obj({'pool':P,'root':F,'slot':U,'blockhash':P,'sequence':U,'next_note_id':U})
sch['Path'] = obj({'snapshot':ref('Root'),'note_id':U,'leaf':F,
    'siblings':array(F,minItems=32,maxItems=32)})
sch['Snapshot'] = obj({'snapshot':ref('Root'),'sha256':H,
    'download_url':{'type':'string','format':'uri'}})
sch['Attestation'] = obj({'deployment_id':S,'manifest_hash':H,
    'direct_oa_enabled':B,'issuer':S,'verifier':S,'evidence':S},
    ['deployment_id','manifest_hash','direct_oa_enabled'])

function_call = obj({'id':S,'type':{'type':'string','const':'function'},
    'function':obj({'name':S,'arguments':S})})
function_tool = obj({'type':{'type':'string','const':'function'},
    'function':obj({'name':S,'description':S,'parameters':obj({},[],True),'strict':B},['name','parameters'])})
message = obj({'role':{'type':'string','enum':['system','developer','user','assistant','tool']},
    'content':{'type':['string','null']},'name':S,'tool_call_id':S,
    'tool_calls':array(function_call)},['role'])
sch['ChatRequest'] = obj({'model':S,'messages':array(message,minItems=1),
    'max_completion_tokens':{'type':'integer','minimum':1},'max_tokens':{'type':'integer','minimum':1},
    'stream':B,'temperature':{'type':'number'},'top_p':{'type':'number'},
    'tools':array(function_tool),'tool_choice':{'anyOf':[S,obj({},[],True)]},
    'stream_options':obj({'include_usage':B},[])},['model','messages'])
sch['ResponsesRequest'] = obj({'model':S,
    'input':{'anyOf':[S,array(obj({},[],True))]},'instructions':S,
    'max_output_tokens':{'type':'integer','minimum':1},'stream':B,
    'store':{'type':'boolean','const':False,'default':False},
    'tools':array(obj({},[],True)),'tool_choice':{'anyOf':[S,obj({},[],True)]}},
    ['model','input','max_output_tokens'])
anthropic_message = obj({'role':{'type':'string','enum':['user','assistant']},
    'content':{'anyOf':[S,array(obj({},[],True))]}})
sch['MessagesRequest'] = obj({'model':S,'messages':array(anthropic_message,minItems=1),
    'max_tokens':{'type':'integer','minimum':1},'system':{'anyOf':[S,array(obj({},[],True))]},
    'stream':B,'temperature':{'type':'number'},'top_p':{'type':'number'},
    'tools':array(obj({},[],True)),'tool_choice':obj({},[],True)},['model','messages','max_tokens'])
sch['CountTokensRequest'] = obj({k:v for k,v in sch['MessagesRequest']['properties'].items()
    if k not in ('max_tokens','stream','temperature','top_p')},['model','messages'])

paths = {}
def response(schema, description='Success'):
    return {'description':description,'content':{'application/json':{'schema':ref(schema)}}}
def add(path, method, operation, result, body=None, auth=None, params=None, code='200', description=''):
    item = {'operationId':operation,'description':description,
        'security':[] if auth is None else [{auth:[]}],
        'responses':{code:response(result), 'default':response('Error','Error; see error contract.')}}
    if body: item['requestBody']={'required':True,'content':{'application/json':{'schema':ref(body)}}}
    if params: item['parameters']=params
    paths.setdefault(path,{})[method]=item
    return item
def parameter(name,schema,loc='path',required=True):
    return {'name':name,'in':loc,'required':required,'schema':schema}
request_param = parameter('request_id',ID)
add('/health','get','health','Health')
add('/zkapi/v1/config','get','config','Manifest')
add('/zkapi/v1/catalog','get','catalog','Catalog')
add('/zkapi/v1/attestation','get','attestation','Attestation')
add('/zkapi/v1/tariffs/{tariff_hash}','get','tariff','Tariff',params=[parameter('tariff_hash',H)])
add('/zkapi/v1/quotes','post','quote','Quote','QuoteRequest')
created = add('/zkapi/v1/sessions','post','createSession','SessionCreated','SessionCreate','ControlToken',code='201',
    description='Exact body retry only. First direct creation may contain provider_key. It is never replayed. Control token hash must match proof-bound authorization.')
created['responses']['200'] = response('SessionStatus','Idempotent existing result, no provider key')
created['responses']['202'] = response('SessionStatus','Reserved; issuance in progress or unknown')
add('/zkapi/v1/sessions/{request_id}','get','sessionStatus','SessionStatus',auth='ControlToken',params=[request_param])
add('/zkapi/v1/sessions/{request_id}/close','post','closeSession','SessionStatus',auth='ControlToken',params=[request_param],code='202')
add('/zkapi/v1/sessions/{request_id}/operations/{operation_id}','get','operationStatus','OperationStatus',
    auth='ControlToken',params=[request_param,parameter('operation_id',ID)])
add('/zkapi/v1/withdraw/clearance','post','clearance','ClearanceResponse','ClearanceRequest',
    description='Nullifier capability; atomic exclusion with AUTH reservation. Rate limited, no wallet identity.')
add('/zkapi/v1/nullifiers/{nullifier}','get','nullifierStatus','NullifierStatus',params=[parameter('nullifier',F)])
for suffix,result in [('summary','DashboardSummary'),('recent','DashboardEvents'),('events','DashboardEvents')]:
    item=add('/admin/v1/dashboard/'+suffix,'get','dashboard'+suffix.title(),result,auth='AdminToken',
        params=[parameter('cursor',S,'query',False)] if suffix!='summary' else None)
    item['servers']=[{'url':'https://admin.example.invalid'}]
    item['description']='Private listener only, network ACL + admin credential. Never exposes prompts, IPs or keys.'
add('/zkapi/v1/tree/root','get','treeRoot','Root')
add('/zkapi/v1/tree/snapshot','get','treeSnapshot','Snapshot')
for suffix in ('path','zero-path'):
    add('/zkapi/v1/tree/notes/{note_id}/'+suffix,'get','note'+suffix.replace('-','').title(),'Path',
        params=[parameter('note_id',U)],description='Finalized snapshot; zero-path only for empty leaf.')

compat = [('/v1/chat/completions','ChatRequest','chatCompletions'),
          ('/v1/responses','ResponsesRequest','responses'),
          ('/v1/messages','MessagesRequest','messages'),
          ('/v1/messages/count_tokens','CountTokensRequest','countTokens')]
for path,body,operation in compat:
    item = {'operationId':operation,'security':[{'ProxyToken':[]},{'AnthropicProxyKey':[]}],
        'description':'Proxy only; validate provider-native nested fields against pinned adapter schema. Reject unsupported modalities/tools before dispatch. Idempotency retry returns status, never reruns inference.',
        'parameters':[parameter('Idempotency-Key',ID,'header')],
        'requestBody':{'required':True,'content':{'application/json':{'schema':ref(body)}}},
        'responses':{'200':{'description':'Provider-native JSON or SSE (count_tokens: JSON only).',
            'headers':{'X-Zkapi-Operation-Id':{'schema':ID}},
            'content':{'application/json':{'schema':obj({},[],True)}}},
            'default':{'description':'Provider-compatible error; X-Zkapi-Error-Code header. No raw provider secrets.'}}}
    if operation != 'countTokens':
        item['responses']['200']['content']['text/event-stream']={'schema':S}
    if operation in ('messages','countTokens'):
        item['parameters'].append(parameter('anthropic-version',S,'header'))
    paths[path]={'post':item}
paths['/v1/models']={'get':{'operationId':'models','security':[{'ProxyToken':[]},{'AnthropicProxyKey':[]}],
    'responses':{'200':{'description':'Provider-compatible allowlisted model list.',
        'content':{'application/json':{'schema':obj({},[],True)}}}}}}

doc = {'openapi':'3.1.0','info':{'title':'Solana zkAPI USDC + Proxy','version':'1.0.0-design',
    'description':'Implementation contract, not a deployed service. JSON amounts are decimal strings. Public control objects reject unknown fields; provider nested payloads require adapter validation.'},
    'servers':[{'url':'https://zkapi.example.invalid'}],
    'paths':paths,'components':{'schemas':sch,'securitySchemes':{
        'ControlToken':{'type':'http','scheme':'bearer','description':'zkc1.<uuid>.<32-byte-secret-base64url>'},
        'ProxyToken':{'type':'http','scheme':'bearer','description':'zkp1.<uuid>.<32-byte-secret-base64url>'},
        'AdminToken':{'type':'http','scheme':'bearer','description':'Admin-only credential on private listener; not a user token.'},
        'AnthropicProxyKey':{'type':'apiKey','in':'header','name':'x-api-key','description':'Same proxy token, never an upstream API key.'}}}}
OUT.mkdir(parents=True,exist_ok=True)
(OUT/'openapi.json').write_text(json.dumps(doc,ensure_ascii=False,indent=2)+'\n')

R=21888242871839275222246405745257275088548364400416034343698204186575808495617
def frame(label,parts):
    label=label.encode('ascii')
    return len(label).to_bytes(2,'big')+label+len(parts).to_bytes(2,'big')+b''.join(len(p).to_bytes(4,'big')+p for p in parts)
def vector(name,label,parts):
    data=frame(label,parts); digest=hashlib.sha256(data).digest()
    return {'name':name,'label':label,'parts_hex':[p.hex() for p in parts],
        'frame_hex':data.hex(),'sha256':digest.hex(),'field':'0x'+(int.from_bytes(digest,'big')%R).to_bytes(32,'big').hex()}
vectors=[vector('vault_synthetic','solana-zkapi-vault-v1',[bytes([n])*32 for n in range(6)]+[bytes([6])]),
    vector('destination_synthetic','solana-zkapi-destination-v1',[bytes(range(32))]),
    vector('destination_changed','solana-zkapi-destination-v1',[bytes(range(31))+b'\x20'])]
auth={'version':'1','deployment_id':'fixture-only','pool':'11111111111111111111111111111111',
    'request_id':'00000000-0000-4000-8000-000000000001','quote_hash':'00'*32,'mode':'proxy',
    'control_secret_hash':'11'*32,'proxy_secret_hash':'22'*32}
# This ASCII/string/null subset has the same canonical encoding as RFC8785 JCS.
canonical=json.dumps(auth,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
vectors.append(vector('authorization_synthetic','solana-zkapi-authorization-v1',[canonical]))
vecdoc={'status':'synthetic_encoding_vectors_not_zk_proofs','fr_modulus':str(R),
    'authorization_fixture':auth,'authorization_jcs_utf8':canonical.decode(),'vectors':vectors,
    'rounding':[{'nano_values':[str(n) for n in vals],'expected_micro':str((sum(vals)+999)//1000)}
        for vals in ([0],[1],[999],[1000],[1001],[400,400],[999,1],[1000000000])],
    'proof_wire':{'decoded_length':256,'coordinate_order':['A.x','A.y','B.x.c0','B.x.c1','B.y.c0','B.y.c1','C.x','C.y'],
        'byte_order':'big_endian','real_proofs':'must_be_generated_in_I02'}}
(OUT/'binding-vectors.json').write_text(json.dumps(vecdoc,ensure_ascii=False,indent=2)+'\n')
print(f'Generated {len(paths)} API paths, {len(sch)} schemas, {len(vectors)} encoding vectors.')
