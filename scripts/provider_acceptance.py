#!/usr/bin/env python3
"""Offline provider configuration and a conservative, reserve-once test budget.

This module never opens a network connection, issues a provider key, or sends
inference. The budget is a test coordinator, not the shared financial ledger.
All reserved maxima remain consumed, including failed/unknown operations.
"""
import argparse
from contextlib import contextmanager
import fcntl
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_STATE = ROOT / 'target/i10-provider-acceptance'
MAX_BUDGET = 10_000_000
CREDENTIALS = {
    'openai': 'ZKAPI_OPENAI_API_KEY',
    'anthropic': 'ZKAPI_ANTHROPIC_API_KEY',
    'openrouter': 'ZKAPI_OPENROUTER_API_KEY',
    'direct_openrouter': 'ZKAPI_OPENROUTER_MANAGEMENT_KEY',
    'direct_oa': 'ZKAPI_OA_ORGANIZATION_KEY',
}
OA_FIELDS = ('ZKAPI_OA_ISSUER_BASE', 'ZKAPI_OA_VERIFIER_BASE',
             'ZKAPI_OA_INFERENCE_BASE', 'ZKAPI_OA_STATION_ID')
ALLOWED_ENV = set(CREDENTIALS.values()) | {v + '_FILE' for v in CREDENTIALS.values()} | set(OA_FIELDS) | {'ZKAPI_PROVIDER_BUDGET_MICRO_USDC'}
ENDPOINTS = {'chat_completions': '/v1/chat/completions', 'responses': '/v1/responses',
             'messages': '/v1/messages', 'count_tokens': '/v1/messages/count_tokens'}
CACHE_UNITS = {
    'inclusive_read': ['cache_read_tokens', 'input_tokens', 'output_tokens'],
    'inclusive_read_write': ['cache_read_tokens', 'cache_write_tokens', 'input_tokens', 'output_tokens'],
    'anthropic_split': ['cache_read_tokens', 'cache_write_1h_tokens', 'cache_write_5m_tokens', 'input_tokens', 'output_tokens'],
}


class Failure(Exception):
    """Static diagnostics only: never include input values or paths."""


def require(condition, message):
    if not condition:
        raise Failure(message)


def canonical(value):
    # The plan/tariff schema permits only ASCII strings, integers and booleans;
    # its tariff JSON therefore has the same encoding as serde_jcs.
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate JSON field')
        result[key] = value
    return result


def read_json(path):
    raw = path.read_bytes()
    require(len(raw) <= 1_048_576, 'JSON size limit')
    return json.loads(raw, object_pairs_hook=strict_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(Failure('invalid JSON number')))


def fields(value, names):
    require(type(value) is dict and set(value) == set(names), 'configuration fields mismatch')


def uint(value, maximum=(1 << 63) - 1, positive=False):
    require(type(value) is str and re.fullmatch(r'0|[1-9][0-9]{0,18}', value) is not None,
            'canonical integer string required')
    number = int(value)
    require((number > 0 if positive else number >= 0) and number <= maximum, 'integer out of range')
    return number


def number(value, maximum, positive=True):
    require(type(value) is int and (value > 0 if positive else value >= 0) and value <= maximum,
            'integer out of range')
    return value


def https(value):
    require(type(value) is str and value.isascii(), 'HTTPS public URL required')
    parsed = urlsplit(value)
    require(parsed.scheme == 'https' and parsed.hostname and not parsed.username and not parsed.password
            and not parsed.query and not parsed.fragment, 'HTTPS public URL required')
    return value


def private(path, directory=False):
    info = path.lstat()
    require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
            'owner-only regular file/directory required')


def make_private(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    private(path, True)


def atomic(path, data, immutable=False):
    if path.exists() or path.is_symlink():
        private(path)
        if immutable:
            require(path.read_bytes() == data, 'persistent configuration changed; preserve previous campaign')
            return
    fd, tmp = tempfile.mkstemp(prefix='.pending-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        parent = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def load_environment(path=None, environ=None):
    """Whitelist only; no expansion, execution, dotenv diagnostics, or copying.

    This deliberately supports one-line unquoted/single/double-quoted values.
    Quoted values are literal, without escape or interpolation processing.
    Process environment wins, matching Node's --env-file behavior.
    """
    result = {}
    if path is not None and path.exists():
        private(path)
        require(path.stat().st_size <= 1_048_576, 'environment file size limit')
        for line in path.read_text().splitlines():
            line = line.strip()
            if line.startswith('export '):
                line = line[7:].lstrip()
            key, sep, value = line.partition('=')
            key = key.strip()
            if not sep or key not in ALLOWED_ENV:
                continue
            require(key not in result, 'duplicate provider environment field')
            value = value.strip()
            if value[:1] in ('"', "'"):
                require(len(value) >= 2 and value[-1] == value[0], 'invalid provider environment quoting')
                value = value[1:-1]
            else:
                value = re.split(r'\s+#', value, maxsplit=1)[0].rstrip()
            result[key] = value
    for key, value in (os.environ if environ is None else environ).items():
        if key in ALLOWED_ENV:
            result[key] = value
    return result


def credentials(env, output=None, roles=None):
    """Only prepare (output != None) reads credential contents or writes copies.

    Preflight checks presence and file metadata, never key validity/permissions
    at the provider. Existing input files are never modified.
    """
    result = {}
    if output is not None:
        make_private(output)
    for role, name in CREDENTIALS.items():
        if roles is not None and role not in roles:
            continue
        raw, reference = env.get(name, ''), env.get(name + '_FILE', '')
        require(not (raw and reference), 'choose one raw or file credential source per role')
        if not raw and not reference:
            result[role] = {'configured': False}
            continue
        path = None
        if reference:
            path = Path(reference)
            require(path.is_absolute(), 'absolute credential file reference required')
            private(path)
            require(0 < path.stat().st_size <= 4096, 'credential file size limit')
        data = None
        if raw:
            data = raw.encode()
        elif output is not None:
            # O_NOFOLLOW closes the check/open symlink race for the final file.
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as stream:
                info = os.fstat(stream.fileno())
                require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                        and info.st_mode & 0o077 == 0, 'credential changed before read')
                data = stream.read(4097)
        if data is not None:
            require(0 < len(data) <= 4096 and all(33 <= byte <= 126 for byte in data),
                    'credential must contain printable ASCII without whitespace')
        entry = {'configured': True, 'source': 'file' if reference else 'environment',
                 'credential_contents_verified': output is not None or raw != ''}
        if output is not None:
            target = output / (role + '.credential')
            atomic(target, data, immutable=True)
            entry['credential_file'] = str(target.resolve())
        result[role] = entry
    return result


def validate_plan(plan, source_root, now=None):
    fields(plan, ['schema', 'campaign_id', 'budget_micro_usdc', 'usd_usdc_ratio', 'max_requests',
                  'max_output_tokens', 'models', 'cases'])
    require(type(plan['schema']) is int and plan['schema'] == 1 and type(plan['campaign_id']) is str
            and re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', plan['campaign_id']), 'invalid campaign identity')
    budget = uint(plan['budget_micro_usdc'], MAX_BUDGET, True)
    require(plan['usd_usdc_ratio'] == '1:1', 'explicit one USD to one USDC test assumption required')
    number(plan['max_requests'], 1000)
    number(plan['max_output_tokens'], 4096)
    require(type(plan['models']) is list and type(plan['cases']) is list, 'model/case arrays required')
    require(len(plan['cases']) <= plan['max_requests'], 'request count exceeds campaign limit')
    models = {}
    for entry in plan['models']:
        fields(entry, ['profile', 'tariff', 'sources'])
        p, t = entry['profile'], entry['tariff']
        fields(t, ['tariff_hash', 'version', 'provider', 'model', 'pricing_basis', 'valid_from',
                   'valid_until', 'rates', 'operator_fee_micro_usdc'])
        uint(t['version'], positive=True)
        start, end = uint(t['valid_from']), uint(t['valid_until'])
        require(start < end and (now is None or start <= now < end), 'tariff validity window unavailable')
        require(t['operator_fee_micro_usdc'] == '0' and type(t['model']) is str and t['model'].isascii(), 'invalid tariff fee/model')
        require(t['tariff_hash'] == sha(canonical({k: v for k, v in t.items() if k != 'tariff_hash'})), 'tariff hash mismatch')
        rates = {}
        for rate in t['rates']:
            fields(rate, ['unit', 'nano_usdc_numerator', 'unit_denominator'])
            require(rate['unit'] not in rates, 'duplicate tariff unit')
            rates[rate['unit']] = Fraction(uint(rate['nano_usdc_numerator']), uint(rate['unit_denominator'], positive=True))
        key = (t['provider'], t['model'])
        require(key not in models, 'duplicate provider/model tariff')
        if p is None:
            require(t['provider'] in ('oa', 'openrouter') and t['model'] == '*'
                    and t['pricing_basis'] == 'provider_reported_usd' and rates == {}, 'invalid direct tariff')
        else:
            fields(p, ['provider', 'model', 'endpoints', 'context_tokens', 'max_output_tokens', 'cache_mode'])
            require((p['provider'], p['model']) == key and p['model'] not in ('', '*')
                    and t['pricing_basis'] == 'fixed_usage_rates', 'proxy profile/tariff mismatch')
            allowed = {'openai': ['chat_completions', 'responses'], 'anthropic': ['messages', 'count_tokens'], 'openrouter': ['chat_completions']}.get(p['provider'], [])
            require(type(p['endpoints']) is list and p['endpoints'] and len(set(p['endpoints'])) == len(p['endpoints'])
                    and all(e in allowed for e in p['endpoints']), 'unsupported native endpoint')
            number(p['context_tokens'], (1 << 53) - 1)
            number(p['max_output_tokens'], (1 << 53) - 1)
            require(p['cache_mode'] in CACHE_UNITS and (p['provider'] == 'anthropic') == (p['cache_mode'] == 'anthropic_split')
                    and list(rates) == CACHE_UNITS[p['cache_mode']], 'all pinned cache rates required in canonical order')
        require(type(entry['sources']) is list and entry['sources'], 'saved primary-source pricing/limit evidence required')
        for source in entry['sources']:
            fields(source, ['url', 'retrieved_at', 'file', 'sha256'])
            https(source['url'])
            require(re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', source['retrieved_at']), 'dated source required')
            path = source_root / source['file']
            require(path.is_file() and path.stat().st_size <= 16 * 1024 * 1024
                    and sha(path.read_bytes()) == source['sha256'], 'saved source hash mismatch')
        models[key] = entry
    ids, reserve = set(), 0
    for case in plan['cases']:
        fields(case, ['id', 'mode', 'provider', 'model', 'endpoint', 'stream', 'tools', 'max_output_tokens',
                      'max_cost_micro_usdc', 'session_ttl_seconds'])
        require(type(case['id']) is str and re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', case['id'])
                and case['id'] not in ids, 'case identity must be unique')
        ids.add(case['id'])
        require(type(case['stream']) is bool and type(case['tools']) is bool, 'explicit case variants required')
        output = number(case['max_output_tokens'], plan['max_output_tokens'])
        cap = uint(case['max_cost_micro_usdc'], budget, True)
        ttl = number(case['session_ttl_seconds'], 300)
        require(type(case['model']) is str and case['model'] not in ('', '*') and case['model'].isascii(), 'explicit inference model required')
        if case['mode'] == 'proxy':
            entry = models.get((case['provider'], case['model']))
            require(entry is not None and entry['profile'] is not None, 'missing proxy model/price evidence')
            p, t = entry['profile'], entry['tariff']
            require(case['endpoint'] in p['endpoints'] and output <= p['max_output_tokens'], 'case exceeds documented model capabilities')
            rates = {r['unit']: Fraction(int(r['nano_usdc_numerator']), int(r['unit_denominator'])) for r in t['rates']}
            # Same conservative upper bound as proxy::request::reserve_bound;
            # the native adapter remains authoritative at real dispatch.
            nano = p['context_tokens'] * max(v for k, v in rates.items() if k != 'output_tokens') + output * rates['output_tokens']
            require(case['endpoint'] != 'count_tokens', 'operator-funded count_tokens requires a separate confirmed external cost bound')
            require(cap * 1000 >= (nano.numerator + nano.denominator - 1) // nano.denominator, 'case budget below full-context reservation')
        else:
            require((case['mode'], case['provider']) in [('direct_oa', 'oa'), ('direct_openrouter', 'openrouter')], 'unsupported direct mode/provider')
            require((case['provider'], '*') in models and case['endpoint'] == 'chat_completions', 'missing direct tariff or unsupported direct endpoint')
            require(case['mode'] != 'direct_oa' or ttl % 60 == 0, 'OA TTL requires whole minutes')
        reserve += cap
    require(reserve <= budget, 'planned conservative reservations exceed total budget')
    return {'planned_requests': len(ids), 'planned_max_micro_usdc': str(reserve),
            'plan_sha256': sha(canonical(plan)), 'native_config_validation_required': True}


def select_profile(plan, role=None, case_ids=None, profile=None):
    """Project execution/configuration only; the original budget identity stays full."""
    if role is None:
        require(not case_ids and profile is None, 'case/profile selection requires a role')
        return None, plan
    require(role in CREDENTIALS, 'unknown provider role')
    name = profile if profile is not None else role
    require(type(name) is str and re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', name), 'invalid profile name')
    eligible = [c for c in plan['cases'] if (c['provider'] if c['mode'] == 'proxy' else c['mode']) == role]
    ids = [c['id'] for c in eligible] if case_ids is None else case_ids
    require(type(ids) is list and ids and all(type(i) is str for i in ids)
            and len(set(ids)) == len(ids) and set(ids) <= {c['id'] for c in eligible},
            'selected cases must be unique cases of the selected role')
    cases = [c for c in eligible if c['id'] in ids]
    keys = {(c['provider'], c['model'] if c['mode'] == 'proxy' else '*') for c in cases}
    models = [m for m in plan['models'] if (m['tariff']['provider'], m['tariff']['model']) in keys]
    selection = {'schema': 1, 'parent_plan_sha256': sha(canonical(plan)), 'role': role,
                 'profile': name, 'case_ids': [c['id'] for c in cases]}
    return selection, {**plan, 'models': models, 'cases': cases}


def preflight(plan, env, source_root, output=None, role=None, case_ids=None, profile=None):
    import time
    summary = validate_plan(plan, source_root, int(time.time()))
    selection, execution = select_profile(plan, role, case_ids, profile)
    if output is not None:
        require(bool(plan['cases']), 'empty template cannot prepare a live provider campaign')
    approved = uint(env.get('ZKAPI_PROVIDER_BUDGET_MICRO_USDC', '0'), MAX_BUDGET)
    require(approved >= int(plan['budget_micro_usdc']), 'explicit environment budget is missing or lower than plan')
    if output is not None and selection is not None:
        make_private(output)
        make_private(output / 'configurations')
        output = output / 'configurations' / selection['profile']
        make_private(output)
        # Pin selection before any credential copy. Partial preparation may
        # reopen only the same selector; it never creates budget capacity.
        atomic(output / 'selection.json', canonical(selection), immutable=True)
    missing, direct, proxy = [], [], []
    selected = set()
    for case in execution['cases']:
        role = case['provider'] if case['mode'] == 'proxy' else case['mode']
        selected.add(role)
    creds = credentials(env, output / 'credentials' if output else None, selected if selection else None)
    for role in selected:
        if not creds[role]['configured']:
            missing.append(CREDENTIALS[role])
    if 'direct_oa' in selected:
        missing.extend(name for name in OA_FIELDS if not env.get(name))
        if all(env.get(name) for name in OA_FIELDS):
            for name in OA_FIELDS[:3]:
                https(env[name])
            require(0 < len(env[OA_FIELDS[3]]) <= 128 and all(32 <= ord(c) <= 126 for c in env[OA_FIELDS[3]]), 'invalid OA station pin')
    if output is not None and not missing:
        for role in sorted(selected):
            credential = creds[role]['credential_file']
            if role == 'direct_openrouter':
                direct.append({'provider': 'openrouter', 'api_base': 'https://openrouter.ai/api/v1',
                               'inference_base': 'https://openrouter.ai/api/v1', 'credential_file': credential,
                               'settlement_grace_seconds': 60})
            elif role == 'direct_oa':
                direct.append({'provider': 'oa', 'issuer_base': env[OA_FIELDS[0]], 'verifier_base': env[OA_FIELDS[1]],
                               'inference_base': env[OA_FIELDS[2]], 'station_id': env[OA_FIELDS[3]], 'credential_file': credential})
            else:
                profiles = [x['profile'] for x in execution['models'] if x['profile'] is not None and x['profile']['provider'] == role]
                proxy.append({'provider': role, 'credential_file': credential, 'local_test_base': None, 'models': profiles})
        atomic(output / 'providers.json', canonical({'direct': direct, 'proxy': proxy}), immutable=True)
        atomic(output / 'tariffs.json', canonical([x['tariff'] for x in execution['models']]), immutable=True)
    summary.update(schema=1, offline=True, network_requests=0, provider_spend_micro_usdc='0',
                   credentials={k: {field: v for field, v in value.items() if field != 'credential_file'} for k, value in creds.items()},
                   missing_environment_fields=sorted(set(missing)), ready_for_native_config_validation=bool(plan['cases']) and not missing,
                   provider_credentials_verified=False, provider_rights_verified=False, g3_passed=False)
    if selection is not None:
        summary.update(selection=selection, selected_requests=len(execution['cases']),
                       selected_max_micro_usdc=str(sum(int(c['max_cost_micro_usdc']) for c in execution['cases'])),
                       configuration_subdirectory='configurations/' + selection['profile'])
    return summary


class Budget:
    """One immutable campaign; reserve once before any possible provider send.

    A full reservation is never released by this helper. Loss/corruption of its
    state refuses further operations, not a fresh budget. A failed fsync may
    consume capacity without sending; this is intentionally conservative.
    """
    def __init__(self, directory, plan):
        self.directory, self.plan = directory, plan
        make_private(directory)

    @contextmanager
    def locked(self):
        lock = self.directory / 'budget.lock'
        fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            private(lock)
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def identity(self):
        return {'schema': 1, 'campaign_id': self.plan['campaign_id'], 'plan_sha256': sha(canonical(self.plan)),
                'budget_micro_usdc': self.plan['budget_micro_usdc'], 'max_requests': self.plan['max_requests']}

    def initialize(self):
        with self.locked():
            require(bool(self.plan['cases']), 'empty template cannot initialize a provider budget')
            marker, state = self.directory / 'budget-identity.json', self.directory / 'budget-state.json'
            if marker.exists() or marker.is_symlink():
                self.load()
                return
            require(not state.exists() and not state.is_symlink(), 'budget state without identity; manual recovery required')
            atomic(marker, canonical(self.identity()), immutable=True)
            # An interruption between these writes fails closed on reopen.
            atomic(state, canonical({'identity': self.identity(), 'reservations': []}), immutable=True)

    def load(self):
        marker, state = self.directory / 'budget-identity.json', self.directory / 'budget-state.json'
        private(marker)
        private(state)
        require(read_json(marker) == self.identity(), 'budget campaign identity mismatch')
        data = read_json(state)
        fields(data, ['identity', 'reservations'])
        require(data['identity'] == self.identity() and type(data['reservations']) is list, 'budget state identity mismatch')
        seen, total = set(), 0
        cases = {c['id']: c for c in self.plan['cases']}
        for item in data['reservations']:
            fields(item, ['case_id', 'max_cost_micro_usdc', 'state'])
            require(item['case_id'] in cases and item['case_id'] not in seen and item['state'] == 'reserved_no_automatic_replay'
                    and item['max_cost_micro_usdc'] == cases[item['case_id']]['max_cost_micro_usdc'], 'invalid budget reservation')
            seen.add(item['case_id'])
            total += uint(item['max_cost_micro_usdc'], MAX_BUDGET, True)
        require(total <= int(self.plan['budget_micro_usdc']) and len(seen) <= self.plan['max_requests'], 'budget exceeded')
        return data, total

    def reserve(self, case_id):
        with self.locked():
            data, total = self.load()
            case = next((c for c in self.plan['cases'] if c['id'] == case_id), None)
            require(case is not None, 'case is not in immutable plan')
            require(all(x['case_id'] != case_id for x in data['reservations']), 'case already reserved; no automatic replay or refund')
            require(total + int(case['max_cost_micro_usdc']) <= int(self.plan['budget_micro_usdc'])
                    and len(data['reservations']) < self.plan['max_requests'], 'campaign budget exhausted')
            data['reservations'].append({'case_id': case_id, 'max_cost_micro_usdc': case['max_cost_micro_usdc'],
                                         'state': 'reserved_no_automatic_replay'})
            atomic(self.directory / 'budget-state.json', canonical(data))
            return {'case_id': case_id, 'reserved_micro_usdc': case['max_cost_micro_usdc'],
                    'remaining_micro_usdc': str(int(self.plan['budget_micro_usdc']) - total - int(case['max_cost_micro_usdc'])),
                    'plan_sha256': self.identity()['plan_sha256'], 'send_authorized_once': True}

    def status(self):
        with self.locked():
            data, total = self.load()
            return {'identity': self.identity(), 'reserved_micro_usdc': str(total),
                    'remaining_micro_usdc': str(int(self.plan['budget_micro_usdc']) - total),
                    'reservations': data['reservations'], 'refunds_supported': False, 'inference_replays_supported': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['preflight', 'prepare', 'budget-init', 'reserve', 'budget-status'])
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--env-file', type=Path)
    parser.add_argument('--state-dir', type=Path, default=DEFAULT_STATE)
    parser.add_argument('--case', action='append')
    parser.add_argument('--role', choices=sorted(CREDENTIALS))
    parser.add_argument('--profile')
    args = parser.parse_args()
    try:
        plan = read_json(args.plan)
        validate_plan(plan, args.plan.resolve().parent)
        if args.command in ('preflight', 'prepare'):
            if args.command == 'prepare':
                require(args.state_dir.resolve().is_relative_to(ROOT / 'target'), 'private credential output must be below ignored target directory')
                make_private(args.state_dir)
            result = preflight(plan, load_environment(args.env_file), args.plan.resolve().parent,
                               args.state_dir if args.command == 'prepare' else None,
                               args.role, args.case, args.profile)
        else:
            require(args.role is None and args.profile is None, 'budget commands always use the full parent plan')
            require((args.command == 'reserve' and args.case is not None and len(args.case) == 1)
                    or (args.command != 'reserve' and args.case is None), 'reserve requires exactly one case')
            budget = Budget(args.state_dir, plan)
            if args.command == 'budget-init':
                env = load_environment(args.env_file)
                require(uint(env.get('ZKAPI_PROVIDER_BUDGET_MICRO_USDC', '0'), MAX_BUDGET) >= int(plan['budget_micro_usdc']),
                        'explicit environment budget required')
                budget.initialize()
                result = budget.status()
            elif args.command == 'reserve':
                result = budget.reserve(args.case[0])
            else:
                result = budget.status()
        print(json.dumps(result, indent=2))
    except Exception as error:
        print(json.dumps({'passed': False, 'error': str(error) if isinstance(error, Failure) else 'offline provider preparation failed; values withheld'}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
