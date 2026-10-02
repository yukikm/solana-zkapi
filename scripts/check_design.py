#!/usr/bin/env python3
"""Offline structural checks for design contracts; not a runtime/security audit."""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
errors = []
def check(ok, message):
    if not ok: errors.append(message)
def read_json(path):
    def pairs(items):
        result = {}
        for k,v in items:
            if k in result: raise ValueError(f'duplicate key: {k}')
            result[k] = v
        return result
    return json.loads(path.read_text(), object_pairs_hook=pairs)

documents = {}
for path in sorted((ROOT/'docs').rglob('*.json')):
    try: documents[path.relative_to(ROOT).as_posix()] = read_json(path)
    except Exception as exc: errors.append(f'{path}: {exc}')

api = documents['docs/contracts/openapi.json']
check(api['openapi'] == '3.1.0', 'OpenAPI version')
def walk(node):
    if isinstance(node,dict):
        yield node
        for v in node.values(): yield from walk(v)
    elif isinstance(node,list):
        for v in node: yield from walk(v)

refs = 0
for node in walk(api):
    if '$ref' in node:
        refs += 1
        target = api
        try:
            assert node['$ref'].startswith('#/')
            for p in node['$ref'][2:].split('/'):
                target = target[p.replace('~1','/').replace('~0','~')]
        except (KeyError,AssertionError): errors.append('Unresolved ref '+node['$ref'])
    if node.get('type') == 'object' and 'required' in node and 'properties' in node:
        check(set(node['required']) <= set(node['properties']), 'Required field not declared')

operation_ids=[]
for route, methods in api['paths'].items():
    for method, operation in methods.items():
        if method not in ('get','post','put','patch','delete'): continue
        operation_ids.append(operation['operationId'])
        actual = {p['name'] for p in operation.get('parameters',[]) if p['in']=='path'}
        check(actual == set(re.findall(r'\{([^}]+)\}',route)), 'Path parameters '+route)
        for alternatives in operation.get('security',[]):
            check(set(alternatives) <= set(api['components']['securitySchemes']), 'Security scheme '+route)
check(len(operation_ids)==len(set(operation_ids)), 'Duplicate operationId')
schemas=api['components']['schemas']
check(schemas['RequestInputs']['minItems']==schemas['RequestInputs']['maxItems']==12,'Request inputs')
check('provider_key' not in schemas['SessionStatus']['properties'],'Recovery leaks provider key')
check(schemas['SessionCreate']['additionalProperties'] is False,'Prompt-free authorization must be strict')
for route in ('/v1/chat/completions','/v1/responses','/v1/messages','/v1/messages/count_tokens'):
    params=api['paths'][route]['post']['parameters']
    check(any(p['name']=='Idempotency-Key' and p['required'] for p in params), 'Missing idempotency '+route)

vectors = documents['docs/contracts/binding-vectors.json']
r=int(vectors['fr_modulus'])
for v in vectors['vectors']:
    label=v['label'].encode('ascii'); parts=[bytes.fromhex(x) for x in v['parts_hex']]
    if v['label']=='solana-zkapi-vault-v1':
        check([len(p) for p in parts]==[32,32,32,32,32,1], 'Vault binding part arity')
        check(parts[-1]==bytes([6]), 'USDC binding decimals')
    framed=len(label).to_bytes(2,'big')+label+len(parts).to_bytes(2,'big')
    for part in parts: framed+=len(part).to_bytes(4,'big')+part
    digest=hashlib.sha256(framed).digest()
    check(framed.hex()==v['frame_hex'],v['name']+' frame')
    check(digest.hex()==v['sha256'],v['name']+' digest')
    check(int.from_bytes(digest,'big')%r==int(v['field'],16),v['name']+' field')
for row in vectors['rounding']:
    total=sum(int(x) for x in row['nano_values'])
    # Independent divmod form, including exact-divisibility boundaries.
    whole,remainder=divmod(total,1000)
    check(whole+bool(remainder)==int(row['expected_micro']),'Rounding vector')
check(vectors['vectors'][1]['field']!=vectors['vectors'][2]['field'],'Destination mutation vector')

reference=documents['docs/ethereum-reference.json']
target=reference['proposed_target']
check(target['billing_asset']=='circle_usdc_on_solana','USDC target')
check(target['proxy_mode']=='required_initial_production','Proxy must be required')
check(reference['observed_mainnet_sdk_config']['trusted_deployment']['billing_asset']=='native_eth','Upstream evidence changed')
check({x['id'] for x in reference['work_items']}=={f'I{i:02}' for i in range(1,13)},'Task IDs')
for item in reference['work_items']:
    check(item['status'] in ('not_started','in_progress','completed','blocked'), 'Unknown implementation status')
    if item['status']!='not_started':
        check((ROOT/'docs/evidence'/f'{item["id"]}.md').is_file(), 'Missing implementation evidence '+item['id'])

parity=(ROOT/'docs/production-parity.md').read_text()
features=re.findall(r'^\| (P\d\d) \|',parity,re.M)
check(sorted(features)==[f'P{i:02}' for i in range(1,37)],'Required feature matrix')
plan=(ROOT/'docs/implementation-plan.md').read_text()
tests=re.findall(r'^\| (T\d\d) \|',plan,re.M)
check(sorted(tests)==[f'T{i:02}' for i in range(1,21)],'Acceptance matrix')

link_count=0
for path in [ROOT/'README.md', *sorted((ROOT/'docs').rglob('*.md'))]:
    text=path.read_text()
    check(text.count('```')%2==0,'Unclosed code fence '+str(path))
    for link in re.findall(r'\]\(([^)]+)\)',text):
        if '://' in link or link.startswith('#'): continue
        link=link.split('#',1)[0]
        if not link: continue
        link_count+=1
        check((path.parent/link).exists(),f'Broken local link {path.name}: {link}')

if errors:
    for error in errors: print('FAIL:',error)
    raise SystemExit(1)
print(f'PASS: {len(documents)} JSON documents; {len(api["paths"])} API paths; {refs} schema references; {link_count} local links.')
print(f'PASS: {len(features)} required features; {len(tests)} acceptance scenarios; {len(vectors["vectors"])} binding vectors; {len(vectors["rounding"])} rounding vectors.')
print('NOT CHECKED BY THIS SCRIPT: real proofs, SVM/CU, PostgreSQL migration, provider integration, independent audit.')
