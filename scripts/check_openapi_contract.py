#!/usr/bin/env python3
"""OpenAPI 3.1 validation plus contract examples.
Optional test dependencies: openapi-spec-validator==0.7.2 (includes jsonschema).
"""
from copy import deepcopy
import json
from pathlib import Path
from openapi_spec_validator import validate
from jsonschema import Draft202012Validator

api=json.loads((Path(__file__).resolve().parents[1]/"docs/contracts/openapi.json").read_text())
validate(api)
schemas=api["components"]["schemas"]
for schema in schemas.values():
    Draft202012Validator.check_schema(schema)

count=0
def case(name, value, valid):
    global count
    schema={"$ref":"#/components/schemas/"+name,"components":api["components"]}
    found=Draft202012Validator(schema).is_valid(value)
    assert found == valid, (name,value,valid)
    count+=1

quote={"mode":"proxy","provider":"openai","models":["fixture"]}
case("QuoteRequest",quote,True)
case("QuoteRequest",{**quote,"provider":"oa"},False)
case("QuoteRequest",{**quote,"models":["*"]},False)
case("QuoteRequest",{**quote,"models":["a","b"]},False)
case("QuoteRequest",{"mode":"direct_oa","provider":"oa","models":["*"]},True)
case("QuoteRequest",{"mode":"direct_oa","provider":"openrouter","models":["*"]},False)
rate={"unit":"input_tokens","nano_usdc_numerator":"1","unit_denominator":"3"}
case("TariffRate",rate,True)
case("TariffRate",{**rate,"unit_denominator":"0"},False)
case("TariffRate",{**rate,"unit":"hosted_tool_fee"},False)
case("ChatRequest",{"model":"fixture","messages":[{"role":"user","content":"a"}],"max_tokens":1,"max_completion_tokens":1},False)
case("OperationStatus",{"operation_id":"00000000-0000-4000-8000-000000000001",
    "request_id":"00000000-0000-4000-8000-000000000002","state":"DONE","response_replayable":False},False)
body={"version":"1","receipt_id":"00000000-0000-4000-8000-000000000001","deployment_id":"fixture",
    "pool":"11111111111111111111111111111111","request_id":"00000000-0000-4000-8000-000000000002",
    "operation_id":None,"billing_effect":"charge","related_receipt_hash":None,"observed_at":"1",
    "evidence_kind":"OPENROUTER_USAGE","provider_request_id":"fixture","provider_evidence_digest":"00"*32,
    "tariff_hash":"00"*32,"usage":[],"provider_reported_usd":"0.0000001","reservation_nano_usdc":"1000",
    "observed_nano_usdc":"100","charged_nano_usdc":"100","operator_loss_nano_usdc":"0","reason":"metered"}
case("ReceiptBody",body,True)
case("ReceiptBody",{**body,"provider_reported_usd":None},False)
case("ReceiptBody",{**body,"provider_reported_usd":"0.100"},False)
case("ReceiptBody",{**body,"unexpected":"x"},False)
case("ReceiptBody",{**body,"operation_id":"00000000-0000-4000-8000-000000000003"},False)

# Schema-only manifest fixtures. Digests/signatures/transcripts below are not valid
# deployment evidence; runtime must also perform the semantic checks in the spec.
public_key = '11111111111111111111111111111111'
digest = 'ab' * 32
tree = {'circuit_id':'solana.zkapi.tree.v1','public_inputs':11,
    'source_bundle_hash':digest,'pk_hash':digest,'vk_hash':digest,
    'verifier_constants_hash':digest,'setup_transcript_hash':None}
authority = {'authority':public_key,'program_id':public_key,'config_hash':digest,
    'threshold':2,'members':[public_key,'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'ComputeBudget111111111111111111111111111111']}
manifest = {
    'deployment_id':'schema-only','manifest_hash':digest,
    **{k:public_key for k in ['genesis_hash','program_id','pool','mint','token_program',
        'quote_public_key','receipt_public_key']},
    'decimals':6,'vault_binding':'0x'+'00'*32,
    'state_key':{'x':'0x'+'00'*32,'y':'0x'+'00'*32},
    'clearance_key':{'x':'0x'+'00'*32,'y':'0x'+'00'*32},
    'circuit_id':'zkapi-v2-note-bound-v1','protocol_layout_version':2,
    'tree_backend':'transition_proof','tree_tag_policy':'proof_bound',
    'circuit_profile_hash':digest,'deployment_environment':'local','setup_profile':'test_only',
    'setup_transcript_hashes':dict.fromkeys(['request','withdrawal','tree']),
    'transaction_formats':['v0_buffer'],
    **{k:digest for k in ['request_pk_hash','request_vk_hash','withdrawal_pk_hash',
        'withdrawal_vk_hash','idl_hash']},
    'cap_micro_usdc':'1000000','note_ttl_seconds':'2592000','challenge_seconds':'86400',
    'control_api_origin':'https://example.invalid','inference_api_origin':'https://example.invalid',
    'manifest_signature':'schema-only','api_endpoints':[],'tariff_hashes':[],
    'artifact_digests':{},'db_schema_version':'1','proving_keys_base_url':'https://example.invalid/',
    'tree_proof_artifacts':tree,'authorities':{'admin':authority,'upgrade':authority}}
case('Manifest',manifest,True)
for changes in [
    {'tree_backend':'sbf_poseidon'}, {'tree_tag_policy':'recompute'},
    {'protocol_layout_version':1}, {'tree_proof_artifacts':None},
    {'tree_proof_artifacts':{**tree,'public_inputs':10}},
    {'transaction_formats':['v1_inline']}, {'transaction_formats':['v0_buffer','v0_buffer']},
    {'deployment_environment':'mainnet'}, {'setup_profile':'ceremony_verified'},
]:
    case('Manifest',{**manifest,**changes},False)
production = deepcopy(manifest)
production.update({'deployment_environment':'mainnet','setup_profile':'ceremony_verified',
    'setup_transcript_hashes':dict.fromkeys(['request','withdrawal','tree'],digest),
    'tree_proof_artifacts':{**tree,'setup_transcript_hash':digest}})
case('Manifest',production,True)
for name in ['request','withdrawal','tree']:
    bad = deepcopy(production)
    bad['setup_transcript_hashes'][name] = None
    case('Manifest',bad,False)
case('Manifest',{**production,'tree_proof_artifacts':tree},False)
print(f"PASS: OpenAPI 3.1, {len(schemas)} schemas, {count} positive/negative examples.")
print("NOT RUN: provider-native nested payload conformance, manifest crypto/setup verification and runtime semantic checks.")
