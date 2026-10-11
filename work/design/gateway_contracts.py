"""Additive finite HTTP schemas. Semantic hashes/bounds also require runtime validation."""
from copy import deepcopy

def extend(sch, paths, obj, array, ref, parameter, U, H, ID, API_ID):
    S={'type':'string'}
    def const(v): return {'const':v}
    def enum(*v): return {'type':'string','enum':list(v)}
    def nullable(v): return {'anyOf':[v,{'type':'null'}]}
    name={'type':'string','pattern':"^[a-z0-9!#$%&'*+.^_`|~-]+$"}
    base64={'type':'string','contentEncoding':'base64','pattern':r'^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'}
    pair={'type':'array','prefixItems':[name,base64],'items':False,'minItems':2,'maxItems':2}
    names=array(name,maxItems=64,uniqueItems=True)
    sch['GatewayHeaderPairs']=array(pair,maxItems=128)
    sch['GatewayAdapterPin']=obj({'id':API_ID,'version':const('1'),'artifact_sha256':H})
    sch['GatewayRoute']=obj({'method':enum('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'),'path':{'type':'string','pattern':r'^/(?!/)[\x21-\x7e]*$','maxLength':1024}})
    sch['GatewayHeaderPolicy']=obj({'request':const('end_to_end'),'request_reject':names,'response':const('end_to_end'),'response_reject':names,'trailers':names,'static_request':ref('GatewayHeaderPairs')})
    media={'oneOf':[{'const':['*']},array({'type':'string','pattern':r"^[a-z0-9!#$%&'+.^_`|~-]+/[a-z0-9!#$%&'+.^_`|~-]+$"},minItems=1,maxItems=64,uniqueItems=True)]}
    sch['GatewayRepresentation']=obj({'request_media_types':media,'response_media_types':media,'request_encoding':const('identity'),'response_encodings':array(enum('br','deflate','gzip','identity'),minItems=1,maxItems=4,uniqueItems=True,contains=const('identity'))})
    limit_bounds={'target_bytes':(1,8192),'header_pairs':(1,128),'header_bytes':(1,32768),'request_bytes':(0,1048576),'response_bytes':(0,16777216),'decoded_response_bytes':(0,67108864),'decode_ratio':(1,64),'parser_bytes':(1,1048576),'relay_buffer_bytes':(1,1048576),'header_seconds':(1,600),'idle_seconds':(1,600),'execution_seconds':(1,600),'max_concurrency':(1,4)}
    sch['GatewayLimits']=obj({k:{**U,'maxLength':len(str(hi)),'description':f'Inclusive integer bounds {lo}..{hi}; enforced at runtime.'} for k,(lo,hi) in limit_bounds.items()})
    sch['GatewayAuthentication']={'oneOf':[obj({'scheme':const(s),'policy_id':API_ID,**({'header':name} if s=='api_key_header' else {})}) for s in ('none','bearer','basic','api_key_header')]}
    sch['GatewayMeterResource']=obj({'provider':enum('openai','anthropic'),'model':{'type':'string','pattern':r'^[\x20-\x7e]{1,256}$'}})
    fixed=obj({'exposure':const('operator_upstream_cost')})
    llm=obj({'provider_contract_sha256':H,'context_max_tokens':{'type':'string','pattern':'^[1-9][0-9]{0,18}$'},'output_max_tokens':{'type':'string','pattern':'^[1-9][0-9]{0,18}$'},'service_tier':{'type':'string','pattern':r'^[\x20-\x7e]{1,64}$'},'extra_cost_policy':enum('reject_unclassified','operator_absorbs_unpriced')})
    sch['GatewayMeter']=obj({'adapter':ref('GatewayAdapterPin'),'resource':nullable(ref('GatewayMeterResource')),'config':{'oneOf':[fixed,llm]},'config_hash':H})
    sch['GatewayMeter']['oneOf']=[{'properties':{'adapter':{'properties':{'id':const('fixed_http')}},'resource':{'type':'null'},'config':fixed}},*({'properties':{'adapter':{'properties':{'id':const(adapter)}},'resource':{'allOf':[ref('GatewayMeterResource'),{'properties':{'provider':const(provider)}}]},'config':llm}} for adapter,provider in [('openai_responses','openai'),('anthropic_messages','anthropic')])]
    status={'type':'integer','minimum':200,'maximum':599}
    sch['GatewayCompletionRule']=obj({'kind':enum('http_complete','provider_terminal_usage'),'billable_statuses':array(status,maxItems=400,uniqueItems=True)})
    sch['ApiBindingV2']=obj({'version':const('2'),'service':API_ID,'operation':API_ID,'mode':const('proxy'),'transport':ref('GatewayAdapterPin'),'origin':{'type':'string','format':'uri','description':'Canonical HTTPS origin; explicit synthetic fixture runtime may use loopback HTTP.'},'routes':array(ref('GatewayRoute'),minItems=1,maxItems=32,uniqueItems=True),'query':const('preserve'),'headers':ref('GatewayHeaderPolicy'),'representation':ref('GatewayRepresentation'),'limits':ref('GatewayLimits'),'authentication':ref('GatewayAuthentication'),'privacy':obj({'identifiers':enum('allow','reject_by_meter'),'resources':enum('stateless','shared_public')}),'meter':ref('GatewayMeter'),'completion':ref('GatewayCompletionRule'),'recovery':obj({'policy':const('finite_unknown_v1'),'reconciliation_seconds':const('900')})})
    sch['ApiBindingV2']['allOf']=[{'properties':{'transport':{'properties':{'id':const('http_finite')}}}}, {'if':{'properties':{'meter':{'properties':{'adapter':{'properties':{'id':const('fixed_http')}}}}}},'then':{'properties':{'completion':{'properties':{'kind':const('http_complete')}},'privacy':{'properties':{'identifiers':const('allow')}}}},'else':{'properties':{'completion':{'properties':{'kind':const('provider_terminal_usage')}}}}}]
    sch['ApiBindingV1']=sch['ApiBinding']
    sch['ApiBinding']={'oneOf':[ref('ApiBindingV1'),ref('ApiBindingV2')]}
    unit={'type':'string','pattern':'^[a-z][a-z0-9_]{0,63}$'}
    count={**U,'maxLength':19,'description':'0..9223372036854775807; exact semantic bound enforced by every runtime.'}
    positive={'type':'string','pattern':'^[1-9][0-9]{0,18}$','description':'1..9223372036854775807.'}
    sch['TariffRateV3']=obj({'unit':unit,'nano_usdc_numerator':count,'unit_denominator':positive,'reservation_max_count':count})
    t=sch['Tariff'];t['properties']['rates']=array({'oneOf':[ref('TariffRate'),ref('TariffRateV3')]},maxItems=32)
    for branch in t['oneOf']:
        branch['properties']['version']={'not':const('3')} if branch['properties'].get('version') is None else branch['properties']['version']
        branch['properties'].setdefault('rates',{})['maxItems']=branch['properties']['rates'].get('maxItems',6)
        if branch['properties'].get('provider',{}).get('const')=='generic':branch['properties']['api']=ref('ApiBindingV1')
    t['oneOf'].append({'properties':{'version':const('3'),'provider':const('generic'),'api':ref('ApiBindingV2'),'pricing_basis':enum('fixed_request','fixed_usage_rates'),'rates':array(ref('TariffRateV3'),minItems=1,maxItems=32)},'required':['api'],'not':{'required':['model']}})
    t['allOf']=[{'if':{'properties':{'version':const('3'),'api':{'properties':{'meter':{'properties':{'adapter':{'properties':{'id':const('fixed_http')}}}}}}}},'then':{'properties':{'pricing_basis':const('fixed_request'),'rates':array(obj({'unit':const('requests'),'nano_usdc_numerator':positive,'unit_denominator':const('1'),'reservation_max_count':const('1')}),minItems=1,maxItems=1)}},'else':{}}]
    t['allOf'].append({'if':{'properties':{'version':const('3'),'pricing_basis':const('fixed_usage_rates')}},'then':{'properties':{'api':{'properties':{'meter':{'properties':{'adapter':{'properties':{'id':enum('openai_responses','anthropic_messages')}}}}}}}}})
    t['allOf'].append({'if':{'properties':{'version':const('3'),'pricing_basis':const('fixed_request')}},'then':{'properties':{'api':{'properties':{'meter':{'properties':{'adapter':{'properties':{'id':const('fixed_http')}}}}}}}}})
    sch['GatewayCompletionEvidence']=obj({'rule_hash':H,'outcome':enum('satisfied','not_satisfied'),'http_status':status})
    gateway_fields={'binding_hash':H,'operation_hmac':H,'meter_hash':H,'resource':nullable(ref('GatewayMeterResource')),'completion':nullable(ref('GatewayCompletionEvidence'))}
    r=sch['ReceiptBody'];r['properties'].update(gateway_fields);r['properties']['version']=enum('1','2','3');r['properties']['usage']=array(obj({'unit':unit,'count':count}),maxItems=32)
    r['allOf'].append({'if':{'properties':{'version':const('3')}},'then':{'required':list(gateway_fields),'properties':{'operation_id':ID,'provider_reported_usd':{'type':'null'},'usage':array(obj({'unit':unit,'count':count}),maxItems=32)},'allOf':[
        {'if':{'properties':{'reason':enum('metered','late_usage')}},'then':{'properties':{'evidence_kind':const('PROXY_USAGE'),'completion':ref('GatewayCompletionEvidence'),'usage':{'minItems':1},'observed_nano_usdc':U,'operator_loss_nano_usdc':U}}},
        {'if':{'properties':{'reason':const('not_dispatched')}},'then':{'properties':{'evidence_kind':const('NOT_DISPATCHED'),'usage':{'maxItems':0},'completion':{'type':'null'},'provider_request_id':{'type':'null'},'provider_evidence_digest':{'type':'null'},'observed_nano_usdc':const('0'),'charged_nano_usdc':const('0'),'operator_loss_nano_usdc':const('0')}}},
        {'if':{'properties':{'reason':const('waived_unknown')}},'then':{'properties':{'evidence_kind':const('UNKNOWN_OPERATOR_LOSS'),'usage':{'maxItems':0},'completion':{'type':'null'},'observed_nano_usdc':{'type':'null'},'charged_nano_usdc':const('0'),'operator_loss_nano_usdc':{'type':'null'}}}},
        {'if':{'properties':{'reason':const('late_usage')}},'then':{'properties':{'billing_effect':const('late_loss_observation'),'related_receipt_hash':H,'charged_nano_usdc':const('0')}},'else':{'properties':{'billing_effect':const('charge'),'related_receipt_hash':{'type':'null'}}}}
    ]},'else':{'not':{'anyOf':[{'required':[k]} for k in gateway_fields]}}})
    sch['GatewayRequestMetadata']=obj({'version':const('2'),'binding_hash':H,'method':sch['GatewayRoute']['properties']['method'],'target':{'type':'string','maxLength':8192},'headers':ref('GatewayHeaderPairs'),'body_length':U})
    sch['GatewayResponseHeaders']=obj({'status':status,'headers':ref('GatewayHeaderPairs')})
    sch['GatewayResponseTrailers']=obj({'headers':ref('GatewayHeaderPairs')})
    sch['GatewayError']=obj({'code':S,'request_id':nullable(ID),'operation_id':nullable(ID)})
    sch['GatewayConfiguration']=obj({'capabilities':{'const':['finite_http_v1']},'mounts':array(obj({'prefix':{'type':'string','pattern':r'^(?:|/[a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)*)$'},'service':API_ID,'operation':API_ID,'binding_hash':H}),minItems=1,maxItems=64,uniqueItems=True)})
    paths['/zkapi/v2/execute/{service}/{operation}']={'post':{'operationId':'executeFiniteHttp','security':[{'ProxyToken':[]}],'description':'Finite raw HTTP execution through the existing reservation and settlement ledger. Framed request commits method, exact target, lossless headers and complete raw body. No implicit retries or redirects. Source capability, not a deployment availability claim.','parameters':[parameter('service',API_ID),parameter('operation',API_ID),parameter('Idempotency-Key',ID,'header')],'requestBody':{'required':True,'content':{'application/vnd.zkapi.http-request.v2':{'schema':{'type':'string','format':'binary','description':'u32be metadata length, JCS GatewayRequestMetadata, then exactly body_length bytes and EOF.'}}}},'responses':{'200':{'description':'Frames: HEADERS DATA* TRAILERS? (END|GATEWAY_ERROR), or GATEWAY_ERROR, then EOF. END attests carrier completion; recover the independently signed charge receipt.','content':{'application/vnd.zkapi.http-response.v2':{'schema':{'type':'string','format':'binary'}}}},'default':{'description':'Bounded prompt-free error; HTTP status does not authorize replay.','content':{'application/json':{'schema':ref('GatewayError')}}}}}}

def standalone(sch, root):
    selected={}
    def visit(value):
        if isinstance(value,dict):
            if '$ref' in value:
                name=value['$ref'].rsplit('/',1)[-1]
                if name not in selected:
                    selected[name]=deepcopy(sch[name]);visit(selected[name])
                value['$ref']='#/$defs/'+name
            for child in value.values():visit(child)
        elif isinstance(value,list):
            for child in value:visit(child)
    result={'$schema':'https://json-schema.org/draft/2020-12/schema','$ref':'#/components/schemas/'+root};visit(result);result['$defs']=selected
    return result

def profile_schemas(sch, root):
    import json
    def load(name):return json.loads((root/'work/design'/name).read_text())
    profile=load('public-profile.base.schema.json')
    profile['$defs'].update(standalone(sch,'Tariff')['$defs'])
    profile['$defs'].update(standalone(sch,'GatewayConfiguration')['$defs'])
    profile['$defs']['LegacyApiTariff']=profile['properties']['services']['items']['properties']['tariff']
    profile['properties']['services']['items']['properties']['tariff']={'oneOf':[{'$ref':'#/$defs/LegacyApiTariff'},{'allOf':[{'$ref':'#/$defs/Tariff'},{'properties':{'version':{'const':'3'}}}]}]}
    profile['properties']['schema']['enum']=[1,2,3]
    profile['properties']['gateway']={'$ref':'#/$defs/GatewayConfiguration'}
    profile['allOf'].append({'if':{'properties':{'schema':{'const':3}}},'then':{'required':['gateway'],'properties':{'mode':{'const':'proxy'},'services':{'minItems':1,'contains':{'properties':{'tariff':{'properties':{'version':{'const':'3'}}}}}}}},'else':{'not':{'required':['gateway']},'properties':{'services':{'items':{'properties':{'tariff':{'$ref':'#/$defs/LegacyApiTariff'}}}}}}})
    project=load('api-project.base.schema.json')
    project['$defs']['legacyService']=project['properties']['services']['items']
    for name in ['ApiBindingV2','TariffRateV3','GatewayConfiguration']:project['$defs'].update(standalone(sch,name)['$defs'])
    u={'type':'string','pattern':'^(0|[1-9][0-9]{0,18})$'};h={'type':'string','pattern':'^[0-9a-f]{64}$'}
    project['$defs']['gatewayService']={'type':'object','additionalProperties':False,'required':['api','rates','validFrom','validUntil','transportArtifactSha256','meterArtifactSha256'],'properties':{'api':{'$ref':'#/$defs/ApiBindingV2'},'rates':{'type':'array','minItems':1,'maxItems':32,'items':{'$ref':'#/$defs/TariffRateV3'}},'validFrom':u,'validUntil':u,'transportArtifactSha256':h,'meterArtifactSha256':h,'credentialFile':{'type':'string','pattern':'^/','maxLength':4096}},'allOf':[{'if':{'properties':{'api':{'properties':{'authentication':{'properties':{'scheme':{'const':'none'}}}}}}},'then':{'not':{'required':['credentialFile']}},'else':{'required':['credentialFile']}}]}
    project['properties']['services']['items']={'oneOf':[{'$ref':'#/$defs/legacyService'},{'$ref':'#/$defs/gatewayService'}]}
    project['properties']['schema']={'enum':[1,2]}
    project['properties']['gateway']={'$ref':'#/$defs/GatewayConfiguration'}
    project['allOf']=[{'if':{'properties':{'schema':{'const':1}}},'then':{'not':{'required':['gateway']},'properties':{'services':{'items':{'$ref':'#/$defs/legacyService'}}}},'else':{'required':['gateway']}}]
    return profile,project
