import argparse
import base64
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/contracts'
parser = argparse.ArgumentParser()
parser.add_argument('--check', action='store_true', help='Compare generated contracts without writing')
CHECK = parser.parse_args().check
def emit(name, value):
    data = json.dumps(value, ensure_ascii=False, indent=2)+'\n'
    path = OUT/name
    if CHECK:
        if not path.exists() or path.read_text() != data:
            raise SystemExit('Generated contract differs: '+name)
    else:
        OUT.mkdir(parents=True, exist_ok=True)
        path.write_text(data)
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
SCALAR = {'type':'string','pattern':'^0x[0-9a-f]{64}$','description':'Canonical Baby-JubJub scalar: 0 <= s < 2736030358979909402780800718157159386076813972158567259200215660948447373041, not BN254 Fr.'}
POS = {'type':'string','pattern':'^[1-9][0-9]*$'}
UNITS = ['cache_read_tokens','cache_write_1h_tokens','cache_write_5m_tokens','cache_write_tokens','input_tokens','output_tokens']
P = {'type': 'string', 'pattern': '^[1-9A-HJ-NP-Za-km-z]{32,44}$', 'description': 'Base58 decoding must yield exactly 32 bytes.'}
ID = {'type': 'string', 'format': 'uuid', 'pattern': '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'}
MODE = {'type': 'string', 'enum': ['proxy', 'direct_openrouter', 'direct_oa']}
PROVIDER = {'type': 'string', 'enum': ['openai', 'anthropic', 'openrouter', 'oa', 'generic']}
sch = {'UInt': U, 'Hash': H, 'Field': F, 'Pubkey': P, 'RequestId': ID,
       'Mode': MODE, 'Provider': PROVIDER, 'Scalar': SCALAR}
sch['Point'] = obj({'x': F, 'y': F})
sch['SchnorrSignature'] = obj({'r_x': F, 'r_y': F, 's': ref('Scalar')})
sch['Proof'] = obj({'backend': {'const': 'groth16_bn254', 'type': 'string'},
    'proof': {'type': 'string', 'contentEncoding': 'base64', 'minLength': 344,
              'maxLength': 344, 'description': 'Strict RFC4648 base64, exactly 256 decoded bytes.'}})
sch['RequestInputs'] = array(F, minItems=12, maxItems=12)
sch['Error'] = obj({'error': obj({'code': S, 'message': S, 'retriable': B,
    'request_id': {'type': ['string','null']}, 'retry_after_seconds': U, 'latest_root': F},
    ['code','message','retriable'])})
API_ID = {'type':'string','pattern':'^[a-z0-9][a-z0-9_-]{0,63}$'}
sch['ApiBinding'] = obj({'version':{'type':'string','const':'1'},'service':API_ID,'operation':API_ID,
    'method':{'type':'string','const':'POST'},'path':{'type':'string','pattern':'^/[A-Za-z0-9/._~-]*$','maxLength':1024,
        'description':'No // prefix or dot/dot-dot segments. No query or encoded path.'},
    'origin':{'type':'string','format':'uri','description':'Canonical origin. Production adapters require HTTPS/public addresses; isolated fixtures require numeric loopback HTTP.'},
    'request_max_bytes':POS,'response_max_bytes':POS,'timeout_seconds':POS,'billing':{'type':'string','const':'http_2xx_json'}})
sch['ApiBinding']['description']='Exact signed operation descriptor. Request/response bounds 1..1048576 bytes; deadline 1..600 seconds.'
sch['QuoteRequest'] = obj({'mode': MODE, 'provider': PROVIDER, 'api':ref('ApiBinding'),
    'models': array(S, minItems=1, maxItems=32, uniqueItems=True),
    'session_ttl_seconds': U},['mode','provider'])
sch['QuoteBody'] = obj({'quote_id': ID, 'deployment_id': S, 'pool': P, 'mode': MODE,
    'provider': PROVIDER, 'models': array(S,minItems=1,uniqueItems=True), 'api':ref('ApiBinding'), 'tariff_hash': H,
    'cap_micro_usdc': U, 'issued_at': U, 'expires_at': U, 'session_ttl_seconds': U,
    'max_concurrency': U, 'control_api_origin': {'type':'string','format':'uri'},
    'inference_api_origin': {'type':'string','format':'uri'}})
sch['QuoteBody']['required']=[k for k in sch['QuoteBody']['required'] if k not in ('models','api')]
sch['Quote'] = obj({'body': ref('QuoteBody'), 'quote_hash': H,
    'signature': {'type':'string','contentEncoding':'base64','description':'64-byte Ed25519 signature over raw quote hash.'}})
for name in ('QuoteRequest','QuoteBody'):
    sch[name]['oneOf'] = [
        {'properties': {'mode': {'const':'direct_oa'}, 'provider': {'const':'oa'}, 'models': {'const':['*']}}},
        {'properties': {'mode': {'const':'direct_openrouter'}, 'provider': {'const':'openrouter'}, 'models': {'const':['*']}}},
        {'properties': {'mode': {'const':'proxy'}, 'provider': {'enum':['openai','anthropic','openrouter']},
            'models': {'minItems':1,'maxItems':1,'items':{'type':'string','minLength':1,'not':{'const':'*'}}}}}
    ]
    for branch in sch[name]['oneOf']:
        branch['required']=['models']
        branch['not']={'required':['api']}
    sch[name]['oneOf'].append({'properties':{'mode':{'const':'proxy'},'provider':{'const':'generic'}},
        'required':['api'],'not':{'required':['models']}})
sch['Authorization'] = obj({'version': {'type':'string','const':'1'},
    'deployment_id': S, 'pool': P, 'request_id': ID, 'quote_hash': H, 'mode': MODE,
    'control_secret_hash': H, 'proxy_secret_hash': {'anyOf':[H,{'type':'null'}]}})
sch['Authorization']['oneOf'] = [
    {'properties': {'mode': {'const':'proxy'}, 'proxy_secret_hash': H}},
    {'properties': {'mode': {'enum':['direct_oa','direct_openrouter']}, 'proxy_secret_hash': {'type':'null'}}}
]
sch['SessionCreate'] = obj({'authorization': ref('Authorization'), 'quote': ref('Quote'),
    'public_inputs': ref('RequestInputs'), 'proof': ref('Proof')})
sch['Settlement'] = obj({'charge_micro_usdc': U, 'next_commitment': ref('Point'),
    'next_anchor': F, 'blind_delta_srv': ref('Scalar'), 'next_state_signature': ref('SchnorrSignature')})
sch['ProviderKeyVerification'] = obj({
    'verifier_url': {'type':'string','format':'uri'},
    'station_id': {'type':'string','minLength':1,'maxLength':128},
    'station_recently_attested': B,
    'key_valid_till': {'type':'integer','minimum':1,'maximum':9007199254740991,
        'description':'Unix seconds retained from the OA verifier wire contract.'},
    'station_signature': {'type':'string','pattern':'^[0-9a-fA-F]{128}$'},
    'org_signature': {'type':'string','pattern':'^[0-9a-fA-F]{128}$'}})
sch['ProviderKeyVerification']['description'] = ('Initial OA key-delivery evidence. The client must validate '
    'the verifier and station against independently configured pins and submit the exact key/signatures '
    'to that verifier before provider use. Server verification does not replace client verification.')
session_props = {'request_id': ID, 'mode': MODE,
    'state': {'type':'string','enum':['RESERVED','ISSUING','ISSUANCE_UNKNOWN','ACTIVE',
        'DRAINING','RECONCILING','SIGN_PENDING','SETTLED']},
    'cap_micro_usdc': U, 'issued_at': U, 'expires_at': U,
    'settlement': ref('Settlement'), 'provider_key': S, 'provider_api_origin': S,
    'provider_key_verification': ref('ProviderKeyVerification'),
    'last_error_code': S}
sch['SessionCreated'] = obj(session_props, ['request_id','mode','state','cap_micro_usdc'])
sch['SessionCreated']['allOf'] = [
    {'if':{'required':['provider_key_verification']},
     'then':{'properties':{'mode':{'const':'direct_oa'},'state':{'const':'ACTIVE'}},
             'required':['provider_key','provider_api_origin','expires_at']}},
    {'if':{'properties':{'mode':{'const':'direct_oa'}},'required':['mode','provider_key']},
     'then':{'required':['provider_key_verification']}}
]
sch['SessionStatus'] = obj({k:v for k,v in session_props.items()
    if k not in ('provider_key','provider_key_verification')},
    ['request_id','mode','state','cap_micro_usdc'])
sch['OperationStatus'] = obj({'operation_id': ID, 'request_id': ID,
    'state': {'type':'string','enum':['RESERVED','DISPATCHING','STREAMING','USAGE_UNKNOWN',
        'METERED','DONE','WAIVED_OPERATOR_LOSS']}, 'charged_nano_usdc': U,
    'usage': obj({},[],True), 'tariff_hash': H, 'response_replayable': {'type':'boolean','const':False}},
    ['operation_id','request_id','state','response_replayable'])
sch['NormalizedUsage'] = array(obj({'unit':{'type':'string','enum':UNITS+['requests']},'count':U}), maxItems=6)
sch['ReceiptBody'] = obj({'version':{'type':'string','enum':['1','2']},'receipt_id':ID,
    'deployment_id':S,'pool':P,'request_id':ID,'operation_id':{'anyOf':[ID,{'type':'null'}]},
    'billing_effect':{'type':'string','enum':['charge','late_loss_observation']},
    'related_receipt_hash':{'anyOf':[H,{'type':'null'}]},'observed_at':U,
    'evidence_kind':{'type':'string','enum':['OA_SIGNED_RECEIPT','OPENROUTER_USAGE','PROXY_USAGE','UNKNOWN_OPERATOR_LOSS','NOT_DISPATCHED']},
    'provider_request_id':{'type':['string','null']},'provider_evidence_digest':{'anyOf':[H,{'type':'null'}]},
    'tariff_hash':H,'usage':ref('NormalizedUsage'),
    'provider_reported_usd':{'anyOf':[{'type':'string','pattern':r'^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$','maxLength':128},{'type':'null'}]},
    'reservation_nano_usdc':U,'observed_nano_usdc':{'anyOf':[U,{'type':'null'}]},'charged_nano_usdc':U,
    'operator_loss_nano_usdc':{'anyOf':[U,{'type':'null'}]},
    'reason':{'type':'string','enum':['metered','not_dispatched','waived_unknown','late_usage']}})
sch['ReceiptBody']['allOf'] = [
    {'if':{'properties':{'version':{'const':'1'}}},'then':{'properties':{'usage':array(obj({'unit':{'type':'string','enum':UNITS},'count':U}),maxItems=6)}}},
    {'if':{'properties':{'version':{'const':'2'}}},'then':{'properties':{'operation_id':ID,'provider_reported_usd':{'type':'null'},
        'usage':array(obj({'unit':{'type':'string','const':'requests'},'count':{'type':'string','enum':['0','1']}}),maxItems=1)}}},
    {'if':{'properties':{'evidence_kind':{'enum':['OA_SIGNED_RECEIPT','OPENROUTER_USAGE']},'reason':{'const':'metered'}},
           'required':['evidence_kind','reason']},
     'then':{'properties':{'provider_reported_usd':{'type':'string'},'operation_id':{'type':'null'},'usage':{'maxItems':0}}}},
    {'if':{'properties':{'operation_id':{'type':'string'}},'required':['operation_id']},
     'then':{'properties':{'provider_reported_usd':{'type':'null'}}}}
]
sch['Receipt'] = obj({'body':ref('ReceiptBody'),'receipt_hash':H,
    'signature':{'type':'string','contentEncoding':'base64','description':'Exactly 64 Ed25519 signature bytes over raw receipt hash.'}})
sch['ReceiptPage'] = obj({'receipts':array(ref('Receipt')),'next_cursor':{'type':['string','null']}})
sch['OperationStatus']['properties']['usage'] = ref('NormalizedUsage')
sch['OperationStatus']['properties'].update({'provider_request_id':{'type':['string','null']},'receipt':ref('Receipt')})
sch['OperationStatus']['allOf'] = [{'if':{'properties':{'state':{'enum':['DONE','WAIVED_OPERATOR_LOSS']}},'required':['state']},
    'then':{'required':['receipt','charged_nano_usdc','tariff_hash']}}]
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
sch['TreeProofArtifacts'] = obj({
    'circuit_id':{'type':'string','const':'solana.zkapi.tree.v1'},
    'public_inputs':{'type':'integer','const':11},
    'source_bundle_hash':H,'pk_hash':H,'vk_hash':H,'verifier_constants_hash':H,
    'setup_transcript_hash':{'anyOf':[H,{'type':'null'}]}})
sch['SetupTranscripts'] = obj({name:{'anyOf':[H,{'type':'null'}]}
    for name in ['request','withdrawal','tree']})
sch['Manifest'] = obj({'deployment_id':S,'manifest_hash':H,'genesis_hash':P,'program_id':P,
    'pool':P,'mint':P,'token_program':P,'decimals':{'type':'integer','const':6},
    'vault_binding':F,'state_key':ref('Point'),'clearance_key':ref('Point'),
    'quote_public_key':P,'circuit_id':{'type':'string','const':'zkapi-v2-note-bound-v1'},
    'protocol_layout_version':{'type':'integer','const':2},
    'tree_backend':{'type':'string','const':'transition_proof'},
    'tree_tag_policy':{'type':'string','const':'proof_bound'},'circuit_profile_hash':H,
    'deployment_environment':{'type':'string','enum':['local','devnet','mainnet']},
    'setup_profile':{'type':'string','enum':['test_only','ceremony_verified']},
    'setup_transcript_hashes':ref('SetupTranscripts'),
    'transaction_formats':array({'type':'string','enum':['v0_buffer','v0_inline','v1_inline','v0_inline_deposit_v1']},
        minItems=1,uniqueItems=True,contains={'const':'v0_buffer'}),
    'request_pk_hash':H,'request_vk_hash':H,'withdrawal_pk_hash':H,'withdrawal_vk_hash':H,
    'cap_micro_usdc':U,'note_ttl_seconds':U,'challenge_seconds':U,
    'control_api_origin':S,'inference_api_origin':S,'manifest_signature':S,
    'idl_hash':H,'api_endpoints':array(S),'tariff_hashes':array(H),
    'artifact_digests':{'type':'object','additionalProperties':H},'db_schema_version':U,
    'proving_keys_base_url':{'type':'string','format':'uri'},
    'tree_proof_artifacts':ref('TreeProofArtifacts')})
sch['MultisigAuthority'] = obj({'authority':P,'program_id':P,'config_hash':H,
    'threshold':{'type':'integer','const':2},'members':array(P,minItems=3,maxItems=3,uniqueItems=True)})
sch['DevnetTestSingleKeyAuthority'] = obj({
    'kind':{'type':'string','const':'devnet_test_single_key'},'authority':P})
sch['DevnetTestSingleKeyAuthority']['description'] = 'Explicit devnet test-only custody. Deployment preflight must independently verify the finalized ProgramData upgrade authority; PoolConfig pins the admin authority.'
sch['DeploymentAuthority'] = {'oneOf':[ref('MultisigAuthority'),ref('DevnetTestSingleKeyAuthority')]}
sch['Manifest']['properties'].update({'receipt_public_key':P,
    'authorities':obj({'admin':ref('DeploymentAuthority'),'upgrade':ref('DeploymentAuthority')})})
sch['Manifest']['required'] += ['receipt_public_key','authorities']
sch['Manifest']['allOf'] = [
    {'if':{'properties':{
        'deployment_environment':{'const':'devnet'},'setup_profile':{'const':'test_only'},
        'genesis_hash':{'const':'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'}},
        'required':['deployment_environment','setup_profile','genesis_hash']},
     'else':{'properties':{'authorities':obj({'admin':ref('MultisigAuthority'),'upgrade':ref('MultisigAuthority')})}}},
    {'if':{'properties':{'deployment_environment':{'const':'mainnet'}}},
     'then':{'properties':{'setup_profile':{'const':'ceremony_verified'}}}},
    {'if':{'properties':{'setup_profile':{'const':'ceremony_verified'}}},
     'then':{'properties':{
         'tree_proof_artifacts':{'properties':{'setup_transcript_hash':H}},
         'setup_transcript_hashes':{'properties':{name:H for name in ['request','withdrawal','tree']}}}},
     'else':{'properties':{
         'tree_proof_artifacts':{'properties':{'setup_transcript_hash':{'type':'null'}}},
         'setup_transcript_hashes':{'properties':{name:{'type':'null'} for name in ['request','withdrawal','tree']}}}}}
]
sch['Manifest']['description'] = 'Layout 2 only; profile digest and artifact hashes are verified semantically against the signed manifest and actual PoolConfig. Transcript presence does not establish ceremony validity. See tree-transition section 5.'
sch['CatalogEntry'] = obj({'model':S,'provider':PROVIDER,'modes':array(MODE),
    'endpoints':array(S),'modalities':array(S),'tariff_hash':H})
sch['Catalog'] = obj({'models':array(ref('CatalogEntry'))})
sch['TariffRate'] = obj({'unit':{'type':'string','enum':UNITS+['requests']},'nano_usdc_numerator':U,'unit_denominator':POS})
sch['Tariff'] = obj({'tariff_hash':H,'version':U,'provider':PROVIDER,'model':S,'api':ref('ApiBinding'),
    'pricing_basis':{'type':'string','enum':['provider_reported_usd','fixed_usage_rates','fixed_request']},
    'valid_from':U,'valid_until':U,'rates':array(ref('TariffRate'),maxItems=6),
    'operator_fee_micro_usdc':{'type':'string','const':'0'}})
sch['Tariff']['required']=[k for k in sch['Tariff']['required'] if k not in ('model','api')]
sch['Tariff']['description'] = 'SHA256 of JCS object excluding tariff_hash; rates sorted by unique unit. See api-proxy section 8 for exact bounds and arithmetic.'
sch['Tariff']['oneOf'] = [
    {'properties':{'pricing_basis':{'const':'provider_reported_usd'},'provider':{'enum':['oa','openrouter']},'model':{'const':'*'},'rates':{'maxItems':0}}},
    {'properties':{'pricing_basis':{'const':'fixed_usage_rates'},'provider':{'enum':['openai','anthropic','openrouter']},'model':{'not':{'const':'*'}},'rates':{'minItems':2}}}
]
for branch in sch['Tariff']['oneOf']:
    branch['required']=['model']
    branch['not']={'required':['api']}
    if branch['properties']['pricing_basis']['const']=='fixed_usage_rates':
        branch['properties']['rates']['items']=obj({'unit':{'type':'string','enum':UNITS},'nano_usdc_numerator':U,'unit_denominator':POS})
sch['Tariff']['oneOf'].append({'properties':{'version':{'const':'2'},'provider':{'const':'generic'},'pricing_basis':{'const':'fixed_request'},
    'rates':array(obj({'unit':{'type':'string','const':'requests'},'nano_usdc_numerator':POS,'unit_denominator':{'type':'string','const':'1'}}),minItems=1,maxItems=1)},
    'required':['api'],'not':{'required':['model']}})
sch['Root'] = obj({'pool':P,'root':F,'slot':U,'blockhash':P,'sequence':U,'next_note_id':U})
sch['Path'] = obj({'snapshot':ref('Root'),'note_id':U,'leaf':F,
    'siblings':array(F,minItems=32,maxItems=32)})
sch['Snapshot'] = obj({'snapshot':ref('Root'),'sha256':H,
    'download_url':{'type':'string','format':'uri'}})
sch['SnapshotNote'] = obj({'note_id':U,'commitment':F,'deposit_micro_usdc':U,'expiry':U})
sch['SnapshotPending'] = obj({**sch['SnapshotNote']['properties'],'nullifier':F,
    'balance_micro_usdc':U,'destination_owner':P,'deadline':U,'old_root':F})
sch['TreeSnapshotFile'] = obj({'schema_version':{'type':'string','const':'1'},'snapshot':ref('Root'),
    'active_notes':array(ref('SnapshotNote')),'pending_withdrawals':array(ref('SnapshotPending'))})
sch['Snapshot']['description'] = 'Download is JCS UTF-8 TreeSnapshotFile without BOM/newline; SHA256 covers exact bytes. Finalized end-of-slot cut.'
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
sch['ChatRequest']['not'] = {'required':['max_tokens','max_completion_tokens']}
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
    description='Exact body retry only. First direct creation may contain provider_key; direct_oa also requires provider_key_verification for independent client verification. Neither field is replayed. Control token hash must match proof-bound authorization.')
created['responses']['200'] = response('SessionStatus','Idempotent existing result, no provider key or verification evidence')
created['responses']['202'] = response('SessionStatus','Proxy may become ACTIVE; direct closes delivery channel, persists close_requested and drains any late key.')
add('/zkapi/v1/sessions/{request_id}','get','sessionStatus','SessionStatus',auth='ControlToken',params=[request_param])
add('/zkapi/v1/sessions/{request_id}/close','post','closeSession','SessionStatus',auth='ControlToken',params=[request_param],code='202')
add('/zkapi/v1/sessions/{request_id}/operations/{operation_id}','get','operationStatus','OperationStatus',
    auth='ControlToken',params=[request_param,parameter('operation_id',ID)])
add('/zkapi/v1/sessions/{request_id}/receipts','get','sessionReceipts','ReceiptPage',
    auth='ControlToken',params=[request_param,parameter('cursor',S,'query',False)])
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
            'headers':{'X-Zkapi-Operation-Id':{'schema':ID},'X-Zkapi-Status-Url':{'schema':S,'description':'Relative control operation status URL.'}},
            'content':{'application/json':{'schema':obj({},[],True)}}},
            'default':{'description':'Provider-compatible error; X-Zkapi-Error-Code header. No raw provider secrets.'}}}
    item['responses']['409'] = {'description':'Operation in progress, response not replayable, or conflicting identity. Never redispatch.',
        'headers':{'X-Zkapi-Operation-Id':{'schema':ID},'X-Zkapi-Status-Url':{'schema':S},'X-Zkapi-Error-Code':{'schema':S}}}
    if operation != 'countTokens':
        item['responses']['200']['content']['text/event-stream']={'schema':S}
    if operation in ('messages','countTokens'):
        item['parameters'].append(parameter('anthropic-version',S,'header'))
    paths[path]={'post':item}
paths['/v1/models']={'get':{'operationId':'models','security':[{'ProxyToken':[]},{'AnthropicProxyKey':[]}],
    'responses':{'200':{'description':'Provider-compatible allowlisted model list.',
        'content':{'application/json':{'schema':obj({},[],True)}}}}}}
paths['/zkapi/v1/api/{service}/{operation}']={'post':{
    'operationId':'executeRegisteredJsonApi','security':[{'ProxyToken':[]}],
    'description':'Registered proxy POST JSON operation, bound to the complete signed ApiBinding. One request unit only for bounded HTTP 2xx JSON; observed HTTP failures cost zero, uncertain execution is never replayed. No arbitrary URL or client-selected upstream headers.',
    'parameters':[parameter('service',API_ID),parameter('operation',API_ID),parameter('Idempotency-Key',ID,'header')],
    'requestBody':{'required':True,'content':{'application/json':{'schema':{}}}},
    'responses':{'200':{'description':'Bounded upstream JSON response. Billing evidence comes from signed version 2 receipts.','content':{'application/json':{'schema':{}}}},
        '409':{'description':'Operation already exists or conflicts; response cannot be replayed.'},'default':{'description':'Failed or unknown operation; inspect saved operation status.'}}}}

doc = {'openapi':'3.1.0','info':{'title':'Solana zkAPI USDC + Proxy','version':'1.0.0-design',
    'description':'Implementation contract, not a deployed service. JSON amounts are decimal strings. Public control objects reject unknown fields; provider nested payloads require adapter validation.'},
    'servers':[{'url':'https://zkapi.example.invalid'}],
    'paths':paths,'components':{'schemas':sch,'securitySchemes':{
        'ControlToken':{'type':'http','scheme':'bearer','description':'zkc1.<uuid>.<32-byte-secret-base64url>'},
        'ProxyToken':{'type':'http','scheme':'bearer','description':'zkp1.<uuid>.<32-byte-secret-base64url>'},
        'AdminToken':{'type':'http','scheme':'bearer','description':'Admin-only credential on private listener; not a user token.'},
        'AnthropicProxyKey':{'type':'apiKey','in':'header','name':'x-api-key','description':'Same proxy token, never an upstream API key.'}}}}
emit('openapi.json', doc)

# Design-time wire contract, not proof/test evidence. Values are fixed by ADR-0001.
tree_fields = ['vault_binding','old_root','new_root','note_id','old_leaf','new_leaf',
    'commitment','deposit','expiry','op','transition_tag']
types = {'u32':4,'u64':8,'F':32,'Proof':256,'WP':14*32,'RP':12*32,'TreeUpdate':11*32+256}
instructions = []
for name, buffer_op, tree_op, args in [
    ('deposit',0,0,[('expected_id','u32'),('expected_root','F'),('expiry','u64'),('commitment','F'),('amount','u64'),('tree','TreeUpdate')]),
    ('mutual_close',1,1,[('public','WP'),('proof','Proof'),('tree','TreeUpdate')]),
    ('initiate_escape',2,1,[('public','WP'),('proof','Proof'),('tree','TreeUpdate')]),
    ('challenge_escape',3,2,[('note_id','u32'),('public','RP'),('proof','Proof'),('tree','TreeUpdate')]),
    ('claim_expired',4,1,[('note_id','u32'),('tree','TreeUpdate')]),
    ('finalize_escape',None,None,[('note_id','u32')]),
]:
    size=sum(types[t] for _,t in args)
    instructions.append({'name':name,'buffer_op':buffer_op,'tree_op':tree_op,
        'args':[{'name':n,'type':t,'bytes':types[t]} for n,t in args],
        'payload_bytes':size,'instruction_data_bytes':8+size,
        'discriminator_hex':hashlib.sha256(('global:'+name).encode('ascii')).digest()[:8].hex()})
emit('tree-transition.json', {
    'schema_version':1,'status':'implementation_contract_not_runtime_evidence',
    'protocol_layout_version':2,'tree_backend':'transition_proof','tree_tag_policy':'proof_bound',
    'circuit_id':'solana.zkapi.tree.v1','depth':32,
    'public_inputs':[{'index':i,'name':n,'bytes':32,'encoding':'canonical_fr_big_endian'} for i,n in enumerate(tree_fields)],
    'tree_update':{'field_order':['public','proof'],'public_bytes':352,'proof_bytes':256,'bytes':608},
    'buffer_payload_includes_discriminator':False,'mandatory_transport':'v0_buffer',
    'compact_deposit':{
        'name':'deposit_compact_v1','capability':'v0_inline_deposit_v1',
        'discriminator_hex':hashlib.sha256(b'global:deposit_compact_v1').digest()[:8].hex(),
        'payload_bytes':436,'instruction_data_bytes':444,'canonical_payload_bytes':692,
        'args':[{'name':n,'type':t,'bytes':types[t]} for n,t in [
            ('expected_id','u32'),('expected_root','F'),('expiry','u64'),('commitment','F'),
            ('amount','u64'),('new_root','F'),('new_leaf','F'),('transition_tag','F'),('tree_proof','Proof')]],
        'public_inputs':['verified_pool.vault_binding','expected_root','new_root','Fr(expected_id)',
            'Fr(0)','new_leaf','commitment','Fr(amount)','Fr(expiry)','Fr(0)','transition_tag'],
        'accounts':'DepositAccounts','buffer_operation':False},
    'instructions':instructions,'compute_budget_target':1000000,'v0_transaction_max_bytes':1232,
    'circuit_profile_fields':['protocol_layout_version','tree_backend','tree_tag_policy','circuit_id',
        'request_pk_hash','request_vk_hash','withdrawal_pk_hash','withdrawal_vk_hash',
        'tree_proof_artifacts','setup_profile','setup_transcript_hashes']})

R=21888242871839275222246405745257275088548364400416034343698204186575808495617
def frame(label,parts):
    label=label.encode('ascii')
    return len(label).to_bytes(2,'big')+label+len(parts).to_bytes(2,'big')+b''.join(len(p).to_bytes(4,'big')+p for p in parts)
def vector(name,label,parts):
    data=frame(label,parts); digest=hashlib.sha256(data).digest()
    return {'name':name,'label':label,'parts_hex':[p.hex() for p in parts],
        'frame_hex':data.hex(),'sha256':digest.hex(),'field':'0x'+(int.from_bytes(digest,'big')%R).to_bytes(32,'big').hex()}
vectors=[vector('vault_synthetic','solana-zkapi-vault-v1',[bytes([n])*32 for n in range(5)]+[bytes([6])]),
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
tariff={'version':'1','provider':'openai','model':'fixture-only','pricing_basis':'fixed_usage_rates',
    'valid_from':'0','valid_until':'2000000000','rates':[
        {'unit':'input_tokens','nano_usdc_numerator':'1','unit_denominator':'3'},
        {'unit':'output_tokens','nano_usdc_numerator':'1','unit_denominator':'3'}],
    'operator_fee_micro_usdc':'0'}
tariff_bytes=json.dumps(tariff,sort_keys=True,separators=(',',':')).encode()
vecdoc['tariff_fixture']={'body':tariff,'jcs_utf8':tariff_bytes.decode(),'tariff_hash':hashlib.sha256(tariff_bytes).hexdigest()}
vecdoc['rate_rounding']=[
    {'terms':[['1','1','3'],['1','1','3']],'expected_nano':'1'},
    {'terms':[['1','1','3'],['2','1','3']],'expected_nano':'1'},
    {'terms':[['1','1','3'],['3','1','3']],'expected_nano':'2'},
    {'terms':[['9223372036854775807','9223372036854775807','9223372036854775807']],'expected_nano':'9223372036854775807'}]
vecdoc['direct_usd_rounding']=[
    {'usd':['0.0000000001'],'cap_micro':'1000000','expected_nano':'1','expected_micro':'1'},
    {'usd':['0.0000004','0.0000004'],'cap_micro':'1000000','expected_nano':'800','expected_micro':'1'},
    {'usd':['1.000000001'],'cap_micro':'1000000','expected_nano':'1000000000','expected_micro':'1000000'}]
emit('binding-vectors.json', vecdoc)
print(f'Generated {len(paths)} API paths, {len(sch)} schemas, {len(vectors)} encoding vectors.')
