import importlib.util
from pathlib import Path
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("run_market", Path(__file__).with_name("run-market.py"))
market = importlib.util.module_from_spec(spec)
spec.loader.exec_module(market)


class MarketLauncherTests(unittest.TestCase):
    def test_repeated_interrupts_cannot_abort_group_or_session_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            script = root / 'supervisor.py'
            script.write_text('''import importlib.util,os,signal,subprocess,sys,time,json
from pathlib import Path
root=Path(sys.argv[1]); session=root/'sdk'; session.mkdir()
spec=importlib.util.spec_from_file_location('market',sys.argv[2]); market=importlib.util.module_from_spec(spec); spec.loader.exec_module(market)
code="import os,signal,time; from pathlib import Path; signal.signal(signal.SIGTERM,signal.SIG_IGN); Path(%r).write_text(str(os.getpid())); time.sleep(60)" % str(root/'child')
child=subprocess.Popen([sys.executable,'-c',code],start_new_session=True)
while not (root/'child').exists(): time.sleep(.01)
original=market.stop_children
def stop(children,grace):
 (root/'cleaning').write_text('ready'); original(children,grace=grace)
market.stop_children=stop
def interrupted(*_): raise KeyboardInterrupt
signal.signal(signal.SIGINT,interrupted); signal.signal(signal.SIGTERM,interrupted)
(root/'ready').write_text('ready')
try: signal.pause()
except KeyboardInterrupt: pass
finally: market.cleanup_runtime([child],session,(root/'log').open('a'),(root/'lock').open('a'),grace=.3)
(root/'done').write_text('done')
''')
            supervisor = subprocess.Popen([sys.executable, str(script), folder, str(Path(market.__file__))], start_new_session=True)
            unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True)
            try:
                for _ in range(100):
                    if (root/'ready').exists(): break
                    time.sleep(.02)
                supervisor.send_signal(signal.SIGINT)
                for _ in range(100):
                    if (root/'cleaning').exists(): break
                    time.sleep(.01)
                supervisor.send_signal(signal.SIGINT)
                supervisor.send_signal(signal.SIGTERM)
                self.assertEqual(supervisor.wait(timeout=5), 0)
                self.assertTrue((root/'done').exists())
                self.assertFalse((root/'sdk').exists())
                self.assertIsNone(unrelated.poll())
            finally:
                market.stop_children([supervisor, unrelated], grace=0)

    def test_occupied_port_fails_without_attaching_or_starting_a_process(self):
        probe = Mock()
        probe.bind.side_effect = OSError('fixture occupied')
        with patch.object(market.socket, 'socket', return_value=probe), patch.object(market.subprocess, 'Popen') as spawn:
            with self.assertRaises(OSError): market.check_ports()
        probe.close.assert_called_once()
        spawn.assert_not_called()

    def test_exited_leader_cannot_leave_a_term_ignoring_grandchild_alive(self):
        with tempfile.TemporaryDirectory() as folder:
            ready = Path(folder) / 'grandchild'
            child_code = "import os,signal,time; from pathlib import Path; signal.signal(signal.SIGTERM,signal.SIG_IGN); Path(%r).write_text(str(os.getpid())); time.sleep(60)" % str(ready)
            code = "import subprocess,sys,signal,time; p=subprocess.Popen([sys.executable,'-c',sys.argv[1]]); signal.signal(signal.SIGTERM,lambda *_: sys.exit(0)); time.sleep(60)"
            parent = subprocess.Popen([sys.executable, '-c', code, child_code], start_new_session=True, stderr=subprocess.DEVNULL)
            try:
                for _ in range(100):
                    if ready.exists(): break
                    time.sleep(.02)
                grandchild = int(ready.read_text())
                market.stop_children([parent], grace=.15)
                self.assertEqual(parent.returncode, 0)
                state = subprocess.run(['/bin/ps', '-o', 'stat=', '-p', str(grandchild)], capture_output=True, text=True).stdout.strip()
                self.assertTrue(not state or state.startswith('Z'), 'grandchild survived group escalation')
            finally:
                market.stop_children([parent], grace=0)

    def test_kills_group_even_if_leader_already_exited(self):
        leader = Mock(pid=43210)
        leader.poll.return_value = 0
        with patch.object(market.os, 'killpg') as kill:
            market.stop_children([leader], grace=0)
        self.assertIn((43210, signal.SIGKILL), [call.args for call in kill.call_args_list])
        leader.wait.assert_called_once_with(timeout=2)

    def test_environment_excludes_credentials_ca_and_frontend_overrides(self):
        source = {key: "not-a-real-secret" for key in ["HOME", "PATH", "SJ_CA_PATH", "SJ_API_KEY", "SHIOAJI_API_KEY", "VITE_API_BASE", "SJ_AGENT_HARNESS_SECRET", "NEO_PWD", "PYTHONPATH"]}
        self.assertEqual(market.clean_environment(source), {"HOME": "not-a-real-secret", "PATH": "not-a-real-secret"})

    def test_group_shutdown_reaps_owned_grandchild_and_keeps_unrelated_process(self):
        with tempfile.TemporaryDirectory() as folder:
            ready = Path(folder) / "ready"
            code = "import subprocess,signal,sys; from pathlib import Path; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); signal.signal(signal.SIGTERM,lambda *_: (p.wait(),sys.exit(0))); Path(sys.argv[1]).write_text(str(p.pid)); signal.pause()"
            parent = subprocess.Popen([sys.executable, "-c", code, str(ready)], start_new_session=True)
            unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
            try:
                for _ in range(100):
                    if ready.exists(): break
                    time.sleep(.02)
                grandchild = int(ready.read_text())
                market.stop_children([parent])
                self.assertEqual(parent.returncode, 0)
                with self.assertRaises(ProcessLookupError): os.kill(grandchild, 0)
                self.assertIsNone(unrelated.poll())
            finally:
                market.stop_children([parent, unrelated])


if __name__ == '__main__': unittest.main()
