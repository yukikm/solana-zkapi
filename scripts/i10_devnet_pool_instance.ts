/** Pure deployment-directory selection. A UI pool instance does not select a
 * new provider profile, create budget capacity, or permit a native lifecycle. */
import assert from 'node:assert/strict';
import {join} from 'node:path';

export function devnetPoolInstance(args: readonly string[], deployment: string,
  poolRun: string | undefined, providerProfile: string | undefined) {
  const options = args.filter(value => value === '--pool-instance' || value.startsWith('--pool-instance='));
  assert.ok(options.length <= 1, 'choose one pool instance');
  const option = options[0];
  const instance = option?.startsWith('--pool-instance=') ? option.slice('--pool-instance='.length) : undefined;
  if (option !== undefined) {
    assert.ok(instance && /^[a-z][a-z0-9-]{0,31}$/.test(instance), 'bounded lowercase pool instance required');
    assert.ok(poolRun === 'provider' && providerProfile === 'openai-ui', 'pool instances require the browser-only OpenAI profile');
    assert.ok(!args.includes('--lifecycle'), 'OpenAI UI profile requires browser wallet');
    const modes = ['--prepare', '--initialize', '--configure'].filter(mode => args.includes(mode));
    assert.equal(modes.length, 1, 'pool instances support one preparation phase only');
    const ports = args.filter(value => value.startsWith('--provider-port='));
    assert.equal(ports.length, 1, 'a separate pool instance requires an explicit service port');
    const raw = ports[0].slice('--provider-port='.length), port = Number(raw);
    assert.ok(/^[1-9][0-9]{3,4}$/.test(raw) && Number.isSafeInteger(port) && port >= 1024 && port <= 65530
      && (port + 4 < 19383 || port > 19387) && (port + 4 < 19180 || port > 19180),
      'a separate pool instance requires a distinct bounded service port');
    for (const mode of ['--deploy', '--admin-check', '--prepare-challenger-key', '--daemon-challenge',
      '--recover-stale-uncertain-auth', '--recover-unaccepted-provider-auth', '--withdraw-settled-provider-case', '--withdraw-unstarted-provider-case']) {
      assert.ok(!args.includes(mode), 'pool instances support preparation only');
    }
  }
  const base = poolRun ? join(deployment, 'pools', poolRun, ...(providerProfile ? [providerProfile] : [])) : deployment;
  // A nested directory cannot collide with a differently named provider profile.
  return {instance, output: instance ? join(base, 'instances', instance) : base,
    deploymentSuffix: instance ? '-instance-' + instance : ''};
}
