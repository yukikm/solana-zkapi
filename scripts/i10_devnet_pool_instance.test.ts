/** Offline argument checks: no environment, private file, RPC or wallet use. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {join} from 'node:path';
import {devnetPoolInstance} from './i10_devnet_pool_instance.ts';

const deployment = '/fixture/target/i10-devnet-vault';
const args = ['--pool-instance=live-demo', '--provider-port=19483', '--prepare'];
const select = (values = args, pool: string | undefined = 'provider', profile: string | undefined = 'openai-ui') =>
  devnetPoolInstance(values, deployment, pool, profile);

test('existing deployment paths and identities are unchanged without a pool instance', () => {
  for (const [pool, profile, output] of [
    [undefined, undefined, deployment], ['wallet-ui', undefined, join(deployment, 'pools/wallet-ui')],
    ['provider', 'openai-ui', join(deployment, 'pools/provider/openai-ui')],
    ['provider', 'openrouter-native-tools', join(deployment, 'pools/provider/openrouter-native-tools')],
  ]) assert.deepEqual(devnetPoolInstance([], deployment, pool, profile), {instance: undefined, output, deploymentSuffix: ''});
});

test('all three browser preparation phases isolate pool data without changing provider selection', () => {
  for (const phase of ['--prepare', '--initialize', '--configure']) {
    const result = select(['--pool-instance=live-demo', '--provider-port=19483', phase]);
    assert.deepEqual(result, {instance: 'live-demo', output: join(deployment, 'pools/provider/openai-ui/instances/live-demo'), deploymentSuffix: '-instance-live-demo'});
    assert.notEqual(result.output, join(deployment, 'pools/provider/openai-ui-live-demo'));
  }
  assert.deepEqual(args, ['--pool-instance=live-demo', '--provider-port=19483', '--prepare']);
});

test('instance names cannot escape, alias or silently select the original deployment', () => {
  for (const name of ['', '.', '..', '../other', 'a/b', 'a\\b', '/tmp/other', 'a%2fb', 'Live-demo', '-live', 'a_b', 'a'.repeat(33), 'live\n']) {
    assert.throws(() => select(['--pool-instance=' + name, '--provider-port=19483', '--prepare']), /bounded lowercase pool instance required/, name);
  }
  assert.throws(() => select(['--pool-instance', '--provider-port=19483', '--prepare']), /bounded lowercase/);
  assert.throws(() => select([...args, '--pool-instance=second']), /choose one pool instance/);
});

test('instance requires the original browser profile and cannot authorize a native lifecycle', () => {
  for (const [pool, profile] of [['wallet-ui', 'openai-ui'], ['provider', 'openai-native'], ['provider', 'openai-ui-live-demo']]) {
    assert.throws(() => select(args, pool, profile), /browser-only OpenAI profile/);
  }
  assert.throws(() => select([...args, '--lifecycle']), /requires browser wallet/);
  for (const mode of ['--deploy', '--admin-check', '--prepare-challenger-key', '--daemon-challenge', '--recover-stale-uncertain-auth',
    '--recover-unaccepted-provider-auth', '--withdraw-settled-provider-case', '--withdraw-unstarted-provider-case']) {
    assert.throws(() => select([...args, mode]), /preparation only/, mode);
  }
  assert.throws(() => select(args.slice(0, 2)), /one preparation phase/);
  assert.throws(() => select([...args, '--initialize']), /one preparation phase/);
});

test('fresh instances require a canonical explicit port distinct from the original UI services', () => {
  for (const port of ['', '19379', '19383', '19387', '19176', '19180', '1023', '65531', '019483', '19483.0', '19483x', '-19483', 'Infinity']) {
    assert.throws(() => select(['--pool-instance=live-demo', '--provider-port=' + port, '--prepare']), /distinct bounded service port/, port);
  }
  assert.throws(() => select(['--pool-instance=live-demo', '--prepare']), /explicit service port/);
  assert.throws(() => select([...args, '--provider-port=19583']), /explicit service port/);
});
