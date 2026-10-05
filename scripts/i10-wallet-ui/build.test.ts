import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildUi, directory} from './build.ts';
import {startUiHost} from './host.ts';

test('production build defaults to live with a separate sample; reused fixture output removes the sample', async t => {
  const output = await mkdtemp(join(tmpdir(), 'zkapi-ui-demo-build-'));
  t.after(() => rm(output, {recursive: true, force: true}));
  await buildUi(output);
  for (const name of ['app.js', 'worker.js', 'demo.js', 'demo.css', 'demo.html', 'index.html', 'style.css']) {
    assert.ok((await stat(join(output, name))).size > 0, name);
  }
  const presentation = await readFile(join(directory, 'demo.html'), 'utf8');
  const live = await readFile(join(directory, 'index.html'), 'utf8');
  assert.notEqual(presentation, live);
  const bundle = await readFile(join(output, 'demo.js'), 'utf8');
  assert.match(bundle, /mountDemo\(document\)/);
  assert.doesNotMatch(bundle, /WalletClient|ControlClient|fetch\(|indexedDB|localStorage|sessionStorage/);
  const productionHost = await startUiHost({port: 0, output});
  try {
    assert.equal(await (await fetch(productionHost.origin + '/')).text(), live);
    assert.equal(await (await fetch(productionHost.origin + '/demo')).text(), presentation);
    assert.equal(await (await fetch(productionHost.origin + '/live')).text(), live);
  } finally { await productionHost.close(); }

  await buildUi(output, true);
  for (const name of ['demo.js', 'demo.css', 'demo.html']) await assert.rejects(stat(join(output, name)), {code: 'ENOENT'});
  const fixtureHost = await startUiHost({port: 0, output});
  try {
    assert.equal(await (await fetch(fixtureHost.origin + '/')).text(), live);
    assert.equal(await (await fetch(fixtureHost.origin + '/live')).text(), live);
    assert.equal((await fetch(fixtureHost.origin + '/demo')).status, 400);
    assert.equal((await fetch(fixtureHost.origin + '/demo.js')).status, 400);
  } finally { await fixtureHost.close(); }
});
