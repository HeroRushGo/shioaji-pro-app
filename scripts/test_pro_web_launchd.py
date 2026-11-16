"""Outer shell lifecycle using temporary fake launchers, never live services."""
import os
import json
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import unittest

WRAPPER = Path(__file__).with_name('pro-web-launchd.zsh')


def wait_file(path, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            return
        time.sleep(.01)
    raise AssertionError('fixture did not become ready: ' + path.name)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def public_environment(root):
    no_rc = root / 'no-rc'
    no_rc.mkdir(mode=0o700, exist_ok=True)
    return {'HOME': str(root / 'home'), 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
            'LANG': 'en_US.UTF-8', 'ZDOTDIR': str(no_rc),
            'TRADING_VAULT': str(root / 'vault'), 'TRADING_LOG_ROOT': str(root / 'logs')}


class LaunchdShellTests(unittest.TestCase):
    def test_outer_shell_waits_for_child_cleanup_and_coalesces_signals(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'scripts').mkdir()
            child = root / 'child.py'
            child.write_text('''import os,signal,subprocess,sys,time
from pathlib import Path
root=Path(sys.argv[1])
grandchild=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])
(root/'grandchild').write_text(str(grandchild.pid))
def stop(*_):
 signal.signal(signal.SIGTERM,signal.SIG_IGN)
 signal.signal(signal.SIGINT,signal.SIG_IGN)
 (root/'cleaning').write_text('ready')
 time.sleep(.25)
 grandchild.terminate()
 grandchild.wait(timeout=3)
 (root/'done').write_text('done')
 sys.exit(0)
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGINT,stop)
(root/'ready').write_text(str(os.getpid()))
signal.pause()
''')
            launcher = root / 'scripts/run-market.zsh'
            launcher.write_text('exec ' + ' '.join(shlex.quote(value) for value in [sys.executable, str(child), folder]) + '\n')
            unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True)
            outer = subprocess.Popen(['/bin/zsh', '-f', str(WRAPPER), folder], start_new_session=True,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                     env=public_environment(root))
            child_pid = grandchild_pid = None
            try:
                wait_file(root / 'ready')
                child_pid = int((root / 'ready').read_text())
                grandchild_pid = int((root / 'grandchild').read_text())
                self.assertNotEqual(outer.pid, child_pid, 'outer shell must remain alive, not exec Python')
                outer.send_signal(signal.SIGTERM)
                wait_file(root / 'cleaning')
                self.assertIsNone(outer.poll(), 'outer shell exited before owned cleanup finished')
                outer.send_signal(signal.SIGTERM)
                outer.send_signal(signal.SIGINT)
                stdout, stderr = outer.communicate(timeout=5)
                self.assertEqual(outer.returncode, 0, stderr)
                self.assertEqual(stdout, '')
                self.assertTrue((root / 'done').exists())
                self.assertFalse(alive(child_pid))
                self.assertFalse(alive(grandchild_pid))
                self.assertIsNone(unrelated.poll())
            finally:
                for pid in [child_pid, grandchild_pid]:
                    if pid and alive(pid):
                        try: os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError: pass
                for process in [outer, unrelated]:
                    if process.poll() is None: process.kill()
                    process.wait(timeout=5)
                if outer.stdout: outer.stdout.close()
                if outer.stderr: outer.stderr.close()

    def test_natural_child_exit_propagates_without_background_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            launcher = Path(folder) / 'scripts/run-market.zsh'
            launcher.parent.mkdir()
            launcher.write_text('exit 7\n')
            result = subprocess.run(['/bin/zsh', '-f', str(WRAPPER), folder], capture_output=True, text=True,
                                    timeout=5, env=public_environment(Path(folder)))
            self.assertEqual(result.returncode, 7)
            self.assertEqual(result.stdout, '')

    def test_missing_main_launcher_fails_clearly_without_spawning(self):
        with tempfile.TemporaryDirectory() as folder:
            result = subprocess.run(['/bin/zsh', '-f', str(WRAPPER), folder], capture_output=True, text=True,
                                    timeout=5, env=public_environment(Path(folder)))
            self.assertEqual(result.returncode, 78)
            self.assertIn('main launcher cannot be opened', result.stderr)
            self.assertEqual(result.stdout, '')

    def test_child_environment_excludes_hostile_parent_keys_overrides_and_rc(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            env = public_environment(root)
            home = Path(env['HOME'])
            home.mkdir()
            rc_marker = root / 'rc-was-sourced'
            (home / '.zshenv').write_text('print sourced > ' + shlex.quote(str(rc_marker)) + '\nexport SJ_API_KEY=rc-key\n')
            launcher = root / 'scripts/run-market.zsh'
            launcher.parent.mkdir()
            child = root / 'capture.py'
            capture = root / 'child-env.json'
            child.write_text('import json,os,sys; from pathlib import Path; Path(sys.argv[1]).write_text(json.dumps(dict(os.environ)))\n')
            launcher.write_text('exec ' + ' '.join(shlex.quote(value) for value in [sys.executable, str(child), str(capture)]) + '\n')
            hostile = {'SJ_API_KEY': 'fixture-key', 'SHIOAJI_API_SECRET': 'fixture-secret',
                       'NEO_PWD': 'fixture-password', 'VITE_API_BASE': 'http://untrusted/',
                       'PYTHONPATH': '/fixture-untrusted-python', 'ZSHENV': 'fixture-override'}
            result = subprocess.run(['/bin/zsh', '-f', str(WRAPPER), folder], env={**env, **hostile},
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            actual = json.loads(capture.read_text())
            for key in hostile:
                self.assertNotIn(key, actual)
            for key, value in env.items():
                self.assertEqual(actual[key], value)
            self.assertFalse(rc_marker.exists())


if __name__ == '__main__':
    unittest.main()
