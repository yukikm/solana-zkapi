#!/usr/bin/env python3
"""Only disposable local process fixtures; no PG, RPC, keys or native journal."""
import json, os, pathlib, signal, subprocess, sys, tempfile, time, unittest
import run_i10_devnet_challenger as launcher

class Fixture(launcher.Challenger):
    def __init__(self, child):
        self.child=child
        self.threads=[]
        self.log_file=None
        self.report={'status':'running'}
        self.events=[]
    def log(self,value):self.events.append(value)
    def record(self):pass

class Shutdown(unittest.TestCase):
    def spawn(self,source):
        ready=self.directory/'ready'
        if ready.exists():ready.unlink()
        process=subprocess.Popen([sys.executable,'-c',source,str(ready)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        self.children.append(process)
        deadline=time.monotonic()+5
        while not ready.exists():
            self.assertIsNone(process.poll())
            self.assertLess(time.monotonic(),deadline)
            time.sleep(.01)
        return process
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='i10-ch-stop-')
        self.directory=pathlib.Path(self.temp.name)
        self.children=[]
    def tearDown(self):
        for process in self.children:
            if process.poll() is None:
                try:os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError:pass
            process.wait(timeout=5)
        self.temp.cleanup()
    def test_graceful_interrupt_is_clean_and_reason_free(self):
        process=self.spawn("import pathlib,signal,sys,time; signal.signal(signal.SIGINT,lambda *_:sys.exit(0)); pathlib.Path(sys.argv[1]).touch(); time.sleep(60)")
        fixture=Fixture(process)
        self.assertTrue(fixture.close())
        self.assertEqual(fixture.report['native_exit_code'],0)
        self.assertEqual(fixture.report['shutdown_reasons'],[])
        self.assertLess(fixture.report['shutdown_milliseconds'],5000)
    def test_already_failed_parent_is_never_clean(self):
        process=self.spawn("import pathlib,sys; pathlib.Path(sys.argv[1]).touch(); sys.exit(7)")
        process.wait(timeout=5)
        fixture=Fixture(process)
        self.assertFalse(fixture.close())
        self.assertEqual(fixture.report['native_exit_code'],7)
        self.assertIn('native_exit_not_zero',fixture.report['shutdown_reasons'])
    def test_timeout_and_group_escalation_are_reported(self):
        process=self.spawn("import pathlib,signal,sys,time; signal.signal(signal.SIGINT,signal.SIG_IGN); pathlib.Path(sys.argv[1]).touch(); time.sleep(60)")
        fixture=Fixture(process)
        original=launcher.STOP_TIMEOUT_SECONDS
        try:
            launcher.STOP_TIMEOUT_SECONDS=.1
            self.assertFalse(fixture.close())
        finally:launcher.STOP_TIMEOUT_SECONDS=original
        self.assertEqual(fixture.report['native_exit_code'],-signal.SIGKILL)
        self.assertEqual(fixture.report['shutdown_reasons'],['native_stop_timeout','remaining_process_group_killed','native_exit_not_zero'])
    def test_exited_parent_with_surviving_descendant_is_unclean(self):
        # Keep a descendant in the launcher's owned group. It has no secret or
        # journal access. Group escalation must remain visible, not a false pass.
        process=self.spawn("import os,pathlib,sys,time; pid=os.fork(); pathlib.Path(sys.argv[1]).touch() if pid else None; time.sleep(60) if not pid else None")
        process.wait(timeout=5)
        fixture=Fixture(process)
        self.assertFalse(fixture.close())
        self.assertEqual(fixture.report['native_exit_code'],0)
        self.assertIn('remaining_process_group_killed',fixture.report['shutdown_reasons'])

if __name__=='__main__':unittest.main()
