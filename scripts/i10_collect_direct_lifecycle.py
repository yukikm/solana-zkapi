#!/usr/bin/env python3
"""Read-only, allowlisted OpenRouter direct lifecycle evidence; never exports handles.

The SQL projects scalars inside PostgreSQL. Raw checkpoint JSON, management
references, keys and their hashes are never returned to this process.
"""
import argparse
from datetime import datetime, timezone
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]
ROLE = "i10_provider_reader"


def require(condition):
    if not condition:
        raise ValueError("direct lifecycle validation failed")


def integer(value):
    require(isinstance(value, str) and re.fullmatch(r"0|[1-9][0-9]{0,38}", value) is not None)
    return int(value)


def decimal(value):
    require(isinstance(value, str) and len(value) <= 128
            and re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", value) is not None)
    return Fraction(value)


def request_uuid(value):
    require(isinstance(value, str))
    parsed = UUID(value)
    require(str(parsed) == value and parsed.version == 4)
    return value


def case_projection(case):
    require(case.get("passed") is True and case.get("mode") == "direct_openrouter"
            and case.get("provider") == "openrouter" and case.get("http_status") == 200
            and type(case.get("inference_sends")) is int and case["inference_sends"] == 1
            and type(case.get("inference_replays")) is int and case["inference_replays"] == 0
            and case.get("signed_successor_verified_by_sdk") is True
            and case.get("evidence_kind") == "OPENROUTER_USAGE")
    require(case.get("case_id") in ("openrouter-direct-plain", "openrouter-direct-sse"))
    require(case.get("stream") is (case["case_id"] == "openrouter-direct-sse"))
    integer(case.get("charged_micro_usdc"))
    return {"case_id": case["case_id"], "request_id": request_uuid(case.get("request_id")),
            "operation_id": request_uuid(case.get("operation_id")), "stream": case["stream"],
            "charged_micro_usdc": case["charged_micro_usdc"], "http_status": 200,
            "inference_sends_reported_by_case": 1, "inference_replays_reported_by_case": 0,
            "signed_successor_verified_by_sdk_reported_by_case": True}


def query(request_id):
    request_id = request_uuid(request_id)  # Canonical UUID only, before SQL interpolation.
    return f"""WITH selected AS (SELECT pool FROM sessions WHERE request_id='{request_id}'::uuid)
SELECT jsonb_build_object(
 'read_only', current_setting('transaction_read_only'), 'role', current_user,
 'sessions', (SELECT coalesce(jsonb_agg(jsonb_build_object(
   'state',s.state,'mode',s.mode,'provider',s.provider,'close_requested',s.close_requested,
   'cap_micro',s.cap_micro::text,'charged_nano',s.charged_nano::text,
   'reserved_nano',s.reserved_nano::text,'active_operations',s.active_operations)), '[]'::jsonb)
   FROM sessions s WHERE s.request_id='{request_id}'::uuid),
 'attempts', (SELECT coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) FROM (
   SELECT d.kind, d.send_claimed_at IS NOT NULL AS send_claimed,
     d.finished_at IS NOT NULL AS finished, d.fenced_at IS NOT NULL AS fenced, count(*)::text AS count
   FROM dispatch_attempts d JOIN selected s ON s.pool=d.pool WHERE d.request_id='{request_id}'::uuid
   GROUP BY d.kind,send_claimed,finished,fenced ORDER BY d.kind,send_claimed,finished,fenced) a),
 'checkpoints', (SELECT coalesce(jsonb_agg(jsonb_build_object(
   'id',o.id::text,'recorded_at_epoch',extract(epoch FROM o.created_at)::text,
   'reference_present',coalesce(jsonb_typeof(o.metadata->'reference')='object',false),
   'disabled_at_epoch',o.metadata->>'disabled_at',
   'observation_at_epoch',o.metadata->'observation'->>'observed_at',
   'observation_usd',o.metadata->'observation'->'usage'->>'provider_reported_usd',
   'observation_nano',o.metadata->'observation'->'usage'->>'observed_nano',
   'observation_kind',o.metadata->'observation'->'usage'->>'evidence_kind',
   'final_usd',o.metadata->'usage'->>'provider_reported_usd',
   'final_nano',o.metadata->'usage'->>'observed_nano',
   'final_kind',o.metadata->'usage'->>'evidence_kind','deleted',o.metadata->'deleted') ORDER BY o.id), '[]'::jsonb)
   FROM outbox o JOIN selected s ON s.pool=o.pool
   WHERE o.event_type='DIRECT_RECOVERY_CHECKPOINT' AND o.metadata->'intent'->>'request_id'='{request_id}'))"""


def usage(row, prefix):
    values = [row[prefix + suffix] for suffix in ("usd", "nano", "kind")]
    if values == [None, None, None]:
        return None
    usd, nano, kind = values
    require(kind == "OPENROUTER_USAGE")
    scaled = decimal(usd) * 1_000_000_000
    require(integer(nano) == -(-scaled.numerator // scaled.denominator))
    return (usd, nano, kind)


def validate(case, observed, minimum_seconds=60):
    require(type(minimum_seconds) is int and 60 <= minimum_seconds <= 86_400)
    public_case = case_projection(case)
    require(observed.get("read_only") == "on" and observed.get("role") == ROLE)
    require(len(observed["sessions"]) == 1)
    session = observed["sessions"][0]
    require(session["state"] == "SETTLED" and session["mode"] == "direct_openrouter"
            and session["provider"] == "openrouter" and session["close_requested"] is True
            and integer(session["reserved_nano"]) == 0 and type(session["active_operations"]) is int
            and session["active_operations"] == 0)
    charged, cap = integer(session["charged_nano"]), integer(session["cap_micro"])
    require(cap > 0 and charged <= cap * 1000)
    require((charged + 999) // 1000 == integer(public_case["charged_micro_usdc"]))
    require(observed["attempts"] == [{"kind": "DIRECT_ISSUANCE", "send_claimed": True,
            "finished": True, "fenced": False, "count": "1"}])
    rows = observed["checkpoints"]
    require(6 <= len(rows) <= 10_000)
    safe_rows, previous_id, reference_seen, disabled, final = [], -1, False, None, None
    final_index = deleted_index = None
    last_observation = None
    for index, row in enumerate(rows):
        row_id = integer(row["id"])
        require(row_id > previous_id and decimal(row["recorded_at_epoch"]) >= 0)
        previous_id = row_id
        require(type(row["reference_present"]) is bool and type(row["deleted"]) is bool)
        require(not reference_seen or row["reference_present"])
        reference_seen |= row["reference_present"]
        if disabled is not None:
            require(row["disabled_at_epoch"] == disabled)
        if row["disabled_at_epoch"] is not None:
            require(reference_seen)
            integer(row["disabled_at_epoch"])
            disabled = row["disabled_at_epoch"]
        observation = usage(row, "observation_")
        current_final = usage(row, "final_")
        if index == 0:
            require(not reference_seen and disabled is None and observation is None
                    and current_final is None and not row["deleted"])
        if observation is None:
            require(row["observation_at_epoch"] is None and last_observation is None)
        else:
            require(disabled is not None)
            observed_at = integer(row["observation_at_epoch"])
            require(observed_at - integer(disabled) >= minimum_seconds)
            if last_observation is not None:
                require(observed_at >= last_observation[0]
                        and integer(observation[1]) >= integer(last_observation[1][1]))
                if final is not None:
                    require((observed_at, observation) == last_observation)
            last_observation = (observed_at, observation)
        if final is not None:
            require(current_final == final)
        if current_final is not None and final is None:
            require(last_observation is not None and current_final == last_observation[1])
            require(decimal(row["recorded_at_epoch"]) - last_observation[0] >= minimum_seconds)
            require(not row["deleted"])
            final, final_index = current_final, index
        if row["deleted"]:
            require(final_index is not None and index > final_index)
            if deleted_index is None:
                deleted_index = index
        else:
            require(deleted_index is None)
        # Reconstruct the public projection, so unexpected fields never enter output.
        safe_rows.append({key: row[key] for key in (
            "id", "recorded_at_epoch", "reference_present", "disabled_at_epoch",
            "observation_at_epoch", "observation_usd", "observation_nano", "observation_kind",
            "final_usd", "final_nano", "final_kind", "deleted")})
    require(final is not None and final_index is not None and deleted_index is not None)
    require(charged == min(integer(final[1]), cap * 1000))
    return {"schema": 1, "passed": True, "scope": "Read-only OpenRouter direct management checkpoint corroboration",
            "case": public_case, "database_read_only": True, "database_role": ROLE,
            "session": {key: session[key] for key in ("state", "mode", "provider", "close_requested",
                "cap_micro", "charged_nano", "reserved_nano", "active_operations")},
            "dispatch_attempts": [{"kind": "DIRECT_ISSUANCE", "send_claimed": True,
                "finished": True, "fenced": False, "count": "1"}],
            "checkpoint_history": safe_rows,
            "checks": {"single_finished_issuance_attempt": True, "management_reference_present": True,
                "disable_recorded": True, "equal_final_and_prior_usage": True,
                "minimum_stability_seconds": minimum_seconds,
                "first_usage_observed_after_disable_grace": True,
                "final_usage_recorded_after_observation_grace": True,
                "final_usage_checkpoint_precedes_deleted_checkpoint": True,
                "settled_session_charge_matches_case_and_usage": True},
            "limitations": [
                "This SELECT corroborates saved runtime checkpoint history, not independent provider packet capture. Outbox history is protected by runtime CAS/order checks, not a database immutability trigger.",
                "The final usage has no independent observation timestamp. The database records when its checkpoint was saved; the second poll's >=60-second delay additionally relies on the reviewed OpenRouter runtime and public configuration invariant.",
                "The deleted flag records successful runtime deletion confirmation (including already-absent responses); exact provider HTTP statuses and response bodies are not retained here.",
                "One issuance attempt is not an inference count. HTTP success, one inference, zero replays and successor verification are reported by the saved case, not independently reverified by this collector.",
                "No raw checkpoints, management references, reference hashes, keys or provider response bodies are read by this process or exported. Final checkpoint stop-evidence binding and cryptographic signatures are not reverified here.",
                "This report does not establish wallet withdrawal, browser/Phantom acceptance, other providers, full I10 or release gates."],
            "collector_actions": {"provider_network_calls": 0, "chain_sends": 0,
                "database_mutations": 0, "budget_or_journal_mutations": 0}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case-json", required=True, type=Path)
    parser.add_argument("--socket", required=True, type=Path)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--psql", default="/opt/homebrew/opt/postgresql@18/bin/psql")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    socket = args.socket.resolve()
    require(socket.is_relative_to(ROOT / "target") and socket.is_dir() and 1 <= args.port <= 65535)
    case_bytes = args.case_json.read_bytes()
    require(len(case_bytes) <= 1_048_576)
    case = json.loads(case_bytes)
    public_case = case_projection(case)
    sql = query(public_case["request_id"])
    command = [args.psql, "-X", "-A", "-t", "-q", "-w", "-v", "ON_ERROR_STOP=1",
               "-h", str(socket), "-p", str(args.port), "-U", ROLE, "-d", "postgres", "-c", sql]
    environment = {"PATH": os.defpath, "PGPASSFILE": os.devnull,
                   "PGOPTIONS": "-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=3000"}
    result = subprocess.run(command, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
    require(result.returncode == 0 and len(result.stdout) <= 1_048_576)
    report = validate(case, json.loads(result.stdout))
    report.update({"collected_at_utc": datetime.now(timezone.utc).isoformat(),
                   "case_file": str(args.case_json), "case_file_sha256": hashlib.sha256(case_bytes).hexdigest(),
                   "collector_source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                   "method": "One SELECT snapshot through i10_provider_reader on a local Unix socket with transaction_read_only=on, statement timeout, explicit scalar projections and no provider calls.",
                   "command_arguments": sys.argv[1:]})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"passed": True, "case_id": public_case["case_id"],
                      "checkpoint_count": len(report["checkpoint_history"]), "output": str(args.output)}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never echo database stderr, malformed values, credentials or raw records.
        print("Direct lifecycle collection failed validation or read-only database access.", file=sys.stderr)
        sys.exit(1)
