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

tree = documents['docs/contracts/tree-transition.json']
check(tree['protocol_layout_version']==2 and tree['tree_backend']=='transition_proof'
      and tree['tree_tag_policy']=='proof_bound','Selected layout 2 backend/policy')
check([p['name'] for p in tree['public_inputs']] == [
    'vault_binding','old_root','new_root','note_id','old_leaf','new_leaf',
    'commitment','deposit','expiry','op','transition_tag'], 'Tree public input order')
check([p['index'] for p in tree['public_inputs']]==list(range(11)), 'Tree input indices')
check(tree['tree_update']=={'field_order':['public','proof'],'public_bytes':352,
    'proof_bytes':256,'bytes':608}, 'TreeUpdate fixed wire')
check(tree['buffer_payload_includes_discriminator'] is False, 'Buffer args only')
check(tree['mandatory_transport']=='v0_buffer' and tree['compute_budget_target']==1000000
      and tree['v0_transaction_max_bytes']==1232, 'CU/transport target')
compact=tree['compact_deposit']
check(compact['name']=='deposit_compact_v1' and compact['capability']=='v0_inline_deposit_v1'
      and compact['buffer_operation'] is False and compact['accounts']=='DepositAccounts', 'Compact deposit capability/accounts')
check((compact['payload_bytes'],compact['instruction_data_bytes'],compact['canonical_payload_bytes'])==(436,444,692), 'Compact deposit sizes')
check([(a['name'],a['bytes']) for a in compact['args']]==[
    ('expected_id',4),('expected_root',32),('expiry',8),('commitment',32),('amount',8),
    ('new_root',32),('new_leaf',32),('transition_tag',32),('tree_proof',256)], 'Compact deposit wire order')
check(compact['public_inputs']==['verified_pool.vault_binding','expected_root','new_root','Fr(expected_id)',
    'Fr(0)','new_leaf','commitment','Fr(amount)','Fr(expiry)','Fr(0)','transition_tag'], 'Compact restored public inputs')
check(compact['discriminator_hex']==hashlib.sha256(b'global:deposit_compact_v1').digest()[:8].hex(), 'Compact discriminator')
expected_ops = {'deposit':(0,0,692),'mutual_close':(1,1,1312),
    'initiate_escape':(2,1,1312),'challenge_escape':(3,2,1252),
    'claim_expired':(4,1,612),'finalize_escape':(None,None,4)}
check({r['name'] for r in tree['instructions']}==set(expected_ops), 'Tree instruction set')
for row in tree['instructions']:
    check((row['buffer_op'],row['tree_op'],row['payload_bytes'])==expected_ops.get(row['name']),
          'Tree instruction mapping '+row['name'])
    check(row['instruction_data_bytes']==row['payload_bytes']+8, 'Anchor prefix '+row['name'])
    check(sum(a['bytes'] for a in row['args'])==row['payload_bytes'], 'Args byte total '+row['name'])
    check(row['discriminator_hex']==hashlib.sha256(('global:'+row['name']).encode()).digest()[:8].hex(),
          'Anchor discriminator '+row['name'])
manifest=schemas['Manifest']
check('v0_inline_deposit_v1' in manifest['properties']['transaction_formats']['items']['enum'], 'Manifest compact capability')
check(set(tree['circuit_profile_fields']) <= set(manifest['required']), 'Profile fields in Manifest')
for key,value in [('protocol_layout_version',2),('tree_backend','transition_proof'),('tree_tag_policy','proof_bound')]:
    check(manifest['properties'][key]['const']==value,'Manifest '+key)
tree_spec=(ROOT/'docs/specs/tree-transition.md').read_text()
check(re.findall(r'^\| (TT\d\d) \|',tree_spec,re.M)==[f'TT{i:02}' for i in range(1,9)],
      'Tree transition acceptance matrix')

link_count=0
# Historical evidence keeps the exact paths tested at that source revision.
# Presentation source moved to an independent repository; current guides must
# use current links, while these explicitly inventoried historical links refer
# to the immutable original Git snapshot recorded in source-migrations.json.
migrations = documents.get('docs/source-migrations.json', {})
historical_paths = migrations.get('paths', {})
check(migrations.get('schema') == 1 and bool(re.fullmatch(r'[0-9a-f]{40}', migrations.get('source_revision', ''))),
      'Historical source migration revision')
for name, entry in historical_paths.items():
    check(name.startswith(('examples/browser-chat/', 'scripts/i10-wallet-ui/'))
          and '..' not in Path(name).parts and bool(re.fullmatch(r'[0-9a-f]{64}', entry.get('sha256', ''))),
          'Invalid historical source migration: ' + name)
for path in [ROOT/'README.md', *sorted((ROOT/'docs').rglob('*.md'))]:
    text=path.read_text()
    check(text.count('```')%2==0,'Unclosed code fence '+str(path))
    for link in re.findall(r'\]\(([^)]+)\)',text):
        if '://' in link or link.startswith('#'): continue
        link=link.split('#',1)[0]
        if not link: continue
        link_count+=1
        target = (path.parent/link).resolve()
        historical = False
        if path.is_relative_to(ROOT/'docs/evidence') and target.is_relative_to(ROOT):
            historical = target.relative_to(ROOT).as_posix() in historical_paths
        check(target.exists() or historical, f'Broken local link {path.name}: {link}')

generated=subprocess.run([sys.executable,str(ROOT/'work/design/generate_contracts.py'),'--check'],capture_output=True,text=True)
check(generated.returncode==0, generated.stdout+generated.stderr)
if errors:
    for error in errors: print('FAIL:',error)
    raise SystemExit(1)
print(f'PASS: {len(documents)} JSON documents; {len(api["paths"])} API paths; {refs} schema references; {link_count} local links.')
print(f'PASS: {len(features)} required features; {len(tests)} acceptance scenarios; {len(vectors["vectors"])} binding vectors; {len(vectors["rounding"])} rounding vectors.')
print('PASS: layout 2 wire/op/profile contract and 8 tree-transition acceptance conditions.')
print('NOT CHECKED BY THIS SCRIPT: real proofs, SVM/CU, PostgreSQL migration, provider integration, independent audit.')
