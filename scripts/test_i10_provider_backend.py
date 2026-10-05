"""Actual isolated PostgreSQL authority checks; no RPC/provider/wallet access."""
import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import run_i10_devnet_backend as backend


@unittest.skipUnless(all(shutil.which(name) for name in ('initdb', 'pg_ctl', 'psql')),
                     'local PostgreSQL tools required')
class ProviderReaderAuthority(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='i10-pr-', dir=backend.ROOT / 'target')
        self.path = Path(self.directory.name)
        self.env = backend.child_env()
        self.data = self.path / 'pg'
        self.socket = self.path / 'socket'
        backend.private_directory(self.socket)
        self.port = 55453
        self.started = False
        try:
            backend.run(['initdb', '-D', str(self.data), '-U', backend.ROLE, '--no-locale',
                         '--encoding=UTF8', '--auth=trust'], self.env, 'test database initialization')
            backend.run(['pg_ctl', '-D', str(self.data), '-l', str(self.path / 'postgres.log'),
                         '-o', f"-k {self.socket} -h '' -p {self.port}", '-w', 'start'],
                        self.env, 'test database start')
            self.started = True
            args = argparse.Namespace(output=self.path, pg_port=self.port, local_adapter=False)
            self.subject = backend.Backend(args)
            self.subject.report['provider_dispatcher'] = {}
            backend.run([str(self.subject.bins / 'controld'), 'migrate'], self.subject.env, 'test migrations')
        except BaseException:
            self.tearDown()
            raise

    def tearDown(self):
        if self.started:
            backend.run(['pg_ctl', '-D', str(self.data), '-m', 'fast', '-w', 'stop'],
                        self.env, 'test database stop')
            self.started = False
        self.directory.cleanup()

    def test_reader_cannot_write_even_after_requesting_read_write_transaction(self):
        self.subject.provision_provider_reader()
        self.subject.provision_provider_reader()  # Restart preserves the same limited role.
        command = list(self.subject.psql)
        command[command.index('-U') + 1] = 'i10_provider_reader'
        result = subprocess.run([*command, 'BEGIN READ WRITE; UPDATE public.pools SET accepting=false; ROLLBACK'],
                                env=self.subject.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'permission denied', result.stderr)
        self.assertTrue(self.subject.report['provider_dispatcher']['select_only_role_verified'])

    def test_existing_writer_grant_is_rejected_without_revoking_it(self):
        self.subject.provision_provider_reader()
        self.subject.sql('GRANT UPDATE ON public.pools TO i10_provider_reader')
        with self.assertRaises(backend.Failure):
            self.subject.provision_provider_reader()
        self.assertEqual(self.subject.sql("SELECT has_table_privilege('i10_provider_reader','public.pools','UPDATE')"), 't')

    def test_existing_role_membership_is_rejected(self):
        self.subject.provision_provider_reader()
        self.subject.sql('CREATE ROLE i10_extra_authority; GRANT i10_extra_authority TO i10_provider_reader')
        with self.assertRaises(backend.Failure):
            self.subject.provision_provider_reader()


if __name__ == '__main__':
    unittest.main()
