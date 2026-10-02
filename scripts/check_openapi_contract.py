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
print(f"PASS: OpenAPI 3.1, {len(schemas)} schemas, {count} positive/negative examples.")
print("NOT RUN: provider-native nested payload conformance and runtime semantic checks.")
