import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:dns/promises';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';

// Local runtime regressions for the October 2026 Node security release.
// No public DNS query, provider request or wallet operation is required.
test('DNS rejects embedded and trailing NUL before resolution (CVE-2026-105482)', async () => {
  for (const name of ['localhost\0.example', 'localhost\0']) {
    await assert.rejects(async () => resolve(name), { code: 'ERR_INVALID_ARG_VALUE' });
  }
});

test('TLS rejects DNS SANs for noncanonical IP forms and accepts canonical IP SANs', () => {
  // checkServerIdentity only reads the SAN in these synthetic certificates.
  const certificate = (subjectaltname: string) => ({ subjectaltname }) as PeerCertificate;
  for (const name of ['１２７.０.０.１', '127.1', '0x7f000001']) {
    const error = checkServerIdentity(name, certificate(`DNS:${name}`)) as NodeJS.ErrnoException | undefined;
    assert.equal(error?.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  }
  assert.equal(checkServerIdentity('127.0.0.1', certificate('IP Address:127.0.0.1')), undefined);
  assert.equal(checkServerIdentity('api.example.com', certificate('DNS:api.example.com')), undefined);
});

test('patched Brotli decoder exposes block-switch rejection and preserves valid decompression', () => {
  // This new security-release constant is not in @types/node 24.19.2 yet.
  assert.equal(Reflect.get(constants, 'BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH'), -17);
  const body = Buffer.from('ZKAPI runtime compatibility\n'.repeat(64));
  assert.deepEqual(brotliDecompressSync(brotliCompressSync(body)), body);
  assert.throws(() => brotliDecompressSync(Buffer.from([0xff, 0xff, 0xff])));
});
