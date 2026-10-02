#!/usr/bin/env python3
"""Offline structural checks for design contracts; not a runtime/security audit."""
import hashlib
import json
import re
import subprocess
import sys
from fractions import Fraction
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
check(schemas['SchnorrSignature']['properties']['s'] == {'$ref':'#/components/schemas/Scalar'}, 'Schnorr scalar type')
check(schemas['Settlement']['properties']['blind_delta_srv'] == {'$ref':'#/components/schemas/Scalar'}, 'Blind scalar type')
check('receipt' in schemas['OperationStatus']['properties'], 'Missing operation receipt')
check({'provider_reported_usd','reservation_nano_usdc'} <= set(schemas['ReceiptBody']['required']), 'Receipt recomputation inputs')
check('allOf' in schemas['OperationStatus'], 'Terminal receipt requirement')
check({'receipt_public_key','authorities'} <= set(schemas['Manifest']['required']), 'Manifest trust fields')
check(schemas['TariffRate']['properties']['unit_denominator']['pattern'] == '^[1-9][0-9]*$', 'Rate denominator permits zero')
check(len(schemas['QuoteRequest']['oneOf']) == 3, 'Mode/provider constraints')
check('TreeSnapshotFile' in schemas, 'Snapshot download contract')
check('/zkapi/v1/sessions/{request_id}/receipts' in api['paths'], 'Receipt recovery path')
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
vault=vectors['vectors'][0]
check(vault['label']=='solana-zkapi-vault-v1', 'Vault vector label')
check(vault['parts_hex']==[bytes([n]).hex()*32 for n in range(5)]+['06'], 'Vault vector must have five raw32 identities then one decimal byte')
canonical=json.dumps(vectors['authorization_fixture'],sort_keys=True,separators=(',',':'))
check(canonical==vectors['authorization_jcs_utf8'], 'Authorization JCS')
check(vectors['vectors'][3]['parts_hex']==[canonical.encode().hex()], 'Authorization binding fixture')
tariff=vectors['tariff_fixture']
canonical=json.dumps(tariff['body'],sort_keys=True,separators=(',',':'))
check(canonical==tariff['jcs_utf8'], 'Tariff JCS')
check(hashlib.sha256(canonical.encode()).hexdigest()==tariff['tariff_hash'], 'Tariff hash')
for row in vectors['rate_rounding']:
    value=sum((Fraction(int(c)*int(n),int(d)) for c,n,d in row['terms']), Fraction())
    check(-(-value.numerator//value.denominator)==int(row['expected_nano']), 'Rate sum rounding')
for row in vectors['direct_usd_rounding']:
    value=sum((Fraction(x) for x in row['usd']),Fraction())*10**9
    nano=min(-(-value.numerator//value.denominator),int(row['cap_micro'])*1000)
    check(nano==int(row['expected_nano']), 'Direct exact USD')
    check((nano+999)//1000==int(row['expected_micro']), 'Direct micro rounding')
check(vectors['vectors'][1]['field']!=vectors['vectors'][2]['field'],'Destination mutation vector')

reference=documents['docs/ethereum-reference.json']
target=reference['proposed_target']
check(target['billing_asset']=='circle_usdc_on_solana','USDC target')
check(target['proxy_mode']=='required_initial_production','Proxy must be required')
check(reference['observed_mainnet_sdk_config']['trusted_deployment']['billing_asset']=='native_eth','Upstream evidence changed')
check({x['id'] for x in reference['work_items']}=={f'I{i:02}' for i in range(1,13)},'Task IDs')
check(all(x['status']=='not_started' for x in reference['work_items']),'Runtime work marked complete')

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

generated=subprocess.run([sys.executable,str(ROOT/'work/design/generate_contracts.py'),'--check'],capture_output=True,text=True)
check(generated.returncode==0, generated.stdout+generated.stderr)
if errors:
    for error in errors: print('FAIL:',error)
    raise SystemExit(1)
print(f'PASS: {len(documents)} JSON documents; {len(api["paths"])} API paths; {refs} schema references; {link_count} local links.')
print(f'PASS: {len(features)} required features; {len(tests)} acceptance scenarios; {len(vectors["vectors"])} binding vectors; {len(vectors["rounding"])} rounding vectors.')
print('NOT RUN: real proofs, SVM/CU, service migration/concurrency, provider integration, independent audit.')
