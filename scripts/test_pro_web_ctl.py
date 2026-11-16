"""Controller acceptance with a fake launchd domain; never touches live jobs."""
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('pro_web_ctl', Path(__file__).with_name('pro_web_ctl.py'))
ctl = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ctl
SPEC.loader.exec_module(ctl)


class FakeSystem:
    def __init__(self, settings):
        self.s = settings
        self.calls = []
        self.definition = None
        self.pid = None
        self.ports = {port: [] for port in ctl.PORTS}
        self.parents = {}
        self.now = 0.0
        self.next_pid = 300
        self.fail_bootstraps = 0
        self.delay_pid_prints = 0
        self.pending_pid = None
        self.last_exit = None
        self.hang_stop = False

    def clock(self):
        return self.now

    def sleep(self, value):
        self.now += value

    def render(self):
        if self.pending_pid is not None:
            if self.delay_pid_prints:
                self.delay_pid_prints -= 1
            else:
                self.pid, self.pending_pid = self.pending_pid, None
                self.ports = {port: [self.pid + index + 1] for index, port in enumerate(ctl.PORTS)}
                self.parents.update({pids[0]: self.pid for pids in self.ports.values()})
        lines = [self.s.target + ' = {', '\tpath = ' + str(self.s.plist),
                 '\tprogram = ' + self.definition['ProgramArguments'][0], '\targuments = {']
        lines.extend('\t\t' + arg for arg in self.definition['ProgramArguments'])
        lines.extend(['\t}', '\tstate = ' + ('running' if self.pid else 'not running')])
        if self.pid is not None:
            lines.append('\tpid = ' + str(self.pid))
        if self.last_exit is not None:
            lines.append('\tlast exit code = ' + str(self.last_exit))
        lines.extend(['\tdomain = {', '\t\tpid = 99999', '\t}', '}'])
        return '\n'.join(lines)

    def run(self, argv, **kwargs):
        argv = [str(value) for value in argv]
        self.calls.append((argv, kwargs))
        code, out = 0, ''
        if argv[0] == '/bin/launchctl':
            action = argv[1]
            if action == 'print':
                code = 0 if self.definition else 113
                out = self.render() if self.definition else ''
            elif action == 'bootstrap':
                if self.fail_bootstraps:
                    self.fail_bootstraps -= 1
                    code = 5
                else:
                    self.definition = plistlib.loads(Path(argv[3]).read_bytes())
                    self.pid = None
            elif action == 'bootout':
                self.definition = None
                self.pid = None
            elif action == 'kickstart':
                if '-k' in argv:
                    raise AssertionError('forced kickstart is forbidden')
                self.next_pid += 10
                self.pending_pid = self.next_pid
            elif action == 'kill':
                if argv[2] != 'SIGTERM':
                    raise AssertionError('only graceful TERM is allowed')
                if not self.hang_stop:
                    self.pid = self.pending_pid = None
                    self.ports = {port: [] for port in ctl.PORTS}
                    self.last_exit = 0
            else:
                raise AssertionError('unexpected launchctl operation: ' + action)
        elif argv[0] == '/usr/sbin/lsof':
            port = int(next(arg.split(':')[1] for arg in argv if arg.startswith('-iTCP:')))
            out = '\n'.join(str(pid) for pid in self.ports[port])
            code = 0 if out else 1
        elif argv[0] == '/bin/ps':
            out = str(self.parents.get(int(argv[-1]), 1))
        elif argv[0] == '/bin/zsh' and argv[-1] == '/usr/bin/true':
            pass  # Public custody preflight, never invoke actual wrapper or SDK.
        elif argv[0] == str(self.s.node) and argv[-1] in ('--version', '-v'):
            out = 'v26.13.0\n'
        else:
            raise AssertionError('unexpected subprocess: ' + repr(argv))
        return subprocess.CompletedProcess(argv, code, out, '')

    def mutations(self):
        return [args[1] for args, _ in self.calls if args[0] == '/bin/launchctl' and args[1] != 'print']


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.s = ctl.Settings(self.root / 'home', self.root / 'main', self.root / 'vault', self.root / 'node/bin/node')
        for folder in [self.s.home, self.s.repo / 'scripts', self.s.python.parent,
                       self.s.node.parent, self.s.log.parent, self.s.vault / 'ops']:
            folder.mkdir(parents=True, mode=0o700, exist_ok=True)
        for path in [self.s.repo / 'scripts/run-market.zsh', self.s.python, self.s.node,
                     self.s.vault / 'ops/workstation-vendor-run.zsh']:
            path.write_text('#!/bin/sh\nexit 0\n')
            path.chmod(0o700)
        self.source = self.root / 'controller.py'
        self.source.write_text('# controller fixture\n')
        self.job_source = self.root / 'job.zsh'
        self.job_source.write_text('# outer shell fixture\n')
        self.system = FakeSystem(self.s)
        self.control = ctl.Controller(self.s, runner=self.system.run, clock=self.system.clock, sleep=self.system.sleep)
        self.original_ready = self.control.ready
        self.control.ready = lambda job: bool(job and job.get('pid'))

    def install(self):
        self.control.install(self.source, self.job_source)
        return json.loads(self.s.config.read_text())

    def test_idle_install_uses_clean_public_environment_and_main_checkout(self):
        with patch.dict(os.environ, {'SJ_API_KEY': 'fixture-secret', 'NEO_PWD': 'fixture-secret', 'VITE_API_BASE': 'http://wrong'}):
            config = self.install()
        definition = plistlib.loads(self.s.plist.read_bytes())
        self.assertFalse(definition['RunAtLoad'])
        self.assertFalse(definition['KeepAlive'])
        self.assertEqual(definition['Umask'], 63)
        self.assertGreaterEqual(definition['ExitTimeOut'], 35)
        self.assertFalse(definition['AbandonProcessGroup'])
        args = definition['ProgramArguments']
        self.assertEqual(args[:2], ['/usr/bin/env', '-i'])
        self.assertEqual(args[-4:-1], ['/bin/zsh', '-f', str(self.s.root / ('job-' + config['jobSha256'] + '.zsh'))])
        self.assertEqual(args[-1], str(self.s.repo))
        self.assertNotIn('EnvironmentVariables', definition)
        self.assertIn('ZDOTDIR=' + str(self.s.root / 'no-rc'), args)
        public = {'HOME', 'PATH', 'LANG', 'TRADING_VAULT', 'TRADING_LOG_ROOT', 'ZDOTDIR'}
        self.assertEqual({arg.split('=')[0] for arg in args[2:-4]}, public)
        self.assertNotIn('fixture-secret', self.s.plist.read_text())
        self.assertEqual(self.system.mutations(), ['bootstrap'])
        self.assertIsNone(self.system.pid)
        self.assertEqual(config['repo'], str(self.s.repo))
        self.assertIn(' -I ', self.s.command.read_text())
        for path in [self.s.config, self.s.plist, self.s.log]:
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.s.command.stat().st_mode & 0o777, 0o700)
        preflight = next(kwargs['env'] for args, kwargs in self.system.calls if args[0] == '/bin/zsh')
        self.assertFalse(set(preflight) - public)

    def test_repeated_install_is_idle_and_preserves_running_pid(self):
        self.install()
        self.control.start()
        pid = self.system.pid
        before = len(self.system.mutations())
        self.install()
        self.assertEqual(self.system.pid, pid)
        self.assertEqual(len(self.system.mutations()), before)

    def test_start_is_idempotent_and_restart_is_graceful(self):
        self.install()
        self.control.start()
        first = self.system.pid
        self.control.start()
        self.assertEqual(self.system.pid, first)
        self.control.restart()
        self.assertNotEqual(self.system.pid, first)
        self.assertEqual(self.system.mutations(), ['bootstrap', 'kickstart', 'kill', 'kickstart'])
        self.control.stop()
        self.assertIsNone(self.system.pid)
        self.assertFalse(any(self.system.ports.values()))

    def test_start_does_not_misread_previous_exit_before_pid_registration(self):
        self.install()
        self.system.last_exit = 78
        self.system.delay_pid_prints = 2
        self.control.start()
        self.assertIsNotNone(self.system.pid)
        self.assertNotIn('kill', self.system.mutations())

    def test_occupied_port_refuses_start_without_any_process_mutation(self):
        self.install()
        self.system.ports[5173] = [70001]
        with self.assertRaises(ctl.ControlError):
            self.control.start()
        self.assertEqual(self.system.mutations(), ['bootstrap'])

    def test_foreign_loaded_job_is_not_stopped_or_replaced(self):
        self.install()
        self.system.definition['ProgramArguments'] = ['/bin/sleep', '60']
        before = list(self.system.mutations())
        for action in [self.control.stop, self.control.start, self.control.uninstall,
                       lambda: self.control.install(self.source, self.job_source)]:
            with self.assertRaises(ctl.ControlError):
                action()
        self.assertEqual(self.system.mutations(), before)

    def test_unknown_installed_command_is_not_overwritten_or_removed(self):
        self.install()
        self.s.command.write_text('#!/bin/sh\n# unrelated user command\n')
        before = list(self.system.mutations())
        for action in [self.control.uninstall, lambda: self.control.install(self.source, self.job_source)]:
            with self.assertRaises(ctl.ControlError):
                action()
        self.assertTrue(self.s.command.exists())
        self.assertEqual(self.system.mutations(), before)

    def test_upgrade_refuses_running_job(self):
        self.install()
        self.control.start()
        self.source.write_text('# revised controller\n')
        before = list(self.system.mutations())
        with self.assertRaises(ctl.ControlError):
            self.control.install(self.source, self.job_source)
        self.assertEqual(self.system.mutations(), before)

    def test_start_timeout_cleans_only_its_job(self):
        config = self.install()
        self.control.ready = lambda _job: False
        with self.assertRaises(ctl.ControlError):
            self.control._start(config, timeout=1)
        self.assertIsNone(self.system.pid)
        self.assertEqual(self.system.mutations(), ['bootstrap', 'kickstart', 'kill'])

    def test_stop_timeout_never_force_kills(self):
        config = self.install()
        self.control.start()
        self.system.hang_stop = True
        with self.assertRaises(ctl.ControlError):
            self.control._stop(config, timeout=.5)
        self.assertIsNotNone(self.system.pid)
        self.assertEqual(self.system.mutations(), ['bootstrap', 'kickstart', 'kill'])

    def test_dead_job_with_remaining_ports_fails_without_port_kill(self):
        self.install()
        self.system.ports[21324] = [70001]
        with self.assertRaises(ctl.ControlError):
            self.control.stop()
        self.assertEqual(self.system.mutations(), ['bootstrap'])

    def test_first_bootstrap_failure_removes_public_entrypoints(self):
        self.system.fail_bootstraps = 1
        with self.assertRaises(ctl.ControlError):
            self.install()
        for path in [self.s.config, self.s.command, self.s.plist]:
            self.assertFalse(path.exists())
        self.assertIsNone(self.system.definition)
        self.assertTrue((self.s.root / 'control.lock').exists())

    def test_failed_upgrade_restores_previous_bytes_and_idle_job(self):
        self.install()
        paths = [self.s.config, self.s.command, self.s.plist]
        saved = {path: path.read_bytes() for path in paths}
        self.source.write_text('# revised controller\n')
        self.system.fail_bootstraps = 1
        with self.assertRaises(ctl.ControlError):
            self.control.install(self.source, self.job_source)
        self.assertEqual({path: path.read_bytes() for path in paths}, saved)
        self.assertEqual(self.system.definition, plistlib.loads(saved[self.s.plist]))
        self.assertIsNone(self.system.pid)
        self.control.load()

    def test_post_bootstrap_command_write_failure_rolls_back_idle_job(self):
        self.install()
        saved = {path: path.read_bytes() for path in [self.s.config, self.s.command, self.s.plist]}
        self.source.write_text('# revised controller\n')
        real_atomic = ctl.atomic
        failed = False
        def fail_command_once(path, data, mode=0o600):
            nonlocal failed
            if path == self.s.command and not failed:
                failed = True
                raise OSError('fixture write failure')
            return real_atomic(path, data, mode)
        with patch.object(ctl, 'atomic', side_effect=fail_command_once):
            with self.assertRaises(OSError):
                self.control.install(self.source, self.job_source)
        self.assertEqual({path: path.read_bytes() for path in saved}, saved)
        self.assertEqual(self.system.definition, plistlib.loads(saved[self.s.plist]))
        self.assertIsNone(self.system.pid)

    def test_uninstall_preserves_lock_code_logs_and_public_watchlists(self):
        config = self.install()
        self.control.start()
        watchlists = self.s.logroot / 'pro-web-state/watchlists.json'
        watchlists.parent.mkdir()
        watchlists.write_text('{"2330":true}')
        lock_inode = (self.s.root / 'control.lock').stat().st_ino
        self.control.uninstall()
        self.assertIsNone(self.system.definition)
        for path in [self.s.plist, self.s.command, self.s.config]:
            self.assertFalse(path.exists())
        self.assertEqual(watchlists.read_text(), '{"2330":true}')
        self.assertTrue(self.s.log.exists())
        self.assertEqual((self.s.root / 'control.lock').stat().st_ino, lock_inode)
        self.assertTrue((self.s.root / ('controller-' + config['controllerSha256'] + '.py')).exists())

    def test_modified_immutable_controller_is_refused_before_start(self):
        config = self.install()
        installed = self.s.root / ('controller-' + config['controllerSha256'] + '.py')
        installed.write_text('# altered\n')
        with self.assertRaises(ctl.ControlError):
            self.control.start()
        self.assertEqual(self.system.mutations(), ['bootstrap'])

    def test_rc_file_in_private_directory_is_refused_before_start(self):
        self.install()
        (self.s.root / 'no-rc/.zshenv').write_text('# fixture rc must never be sourced\n')
        with self.assertRaises(ctl.ControlError):
            self.control.start()
        self.assertEqual(self.system.mutations(), ['bootstrap'])

    def test_group_readable_private_directory_is_refused_before_start(self):
        self.install()
        (self.s.root / 'no-rc').chmod(0o750)
        with self.assertRaises(ctl.ControlError):
            self.control.start()
        self.assertEqual(self.system.mutations(), ['bootstrap'])

    def test_symlinked_command_refused_without_touching_target(self):
        outside = self.root / 'unrelated'
        outside.write_text('preserve')
        self.s.command.parent.mkdir(parents=True)
        self.s.command.symlink_to(outside)
        with self.assertRaises(ctl.ControlError):
            self.install()
        self.assertEqual(outside.read_text(), 'preserve')
        self.assertEqual(self.system.mutations(), [])

    def test_real_readiness_refuses_an_unrelated_listener_before_http(self):
        config = self.install()
        self.control.start()
        self.system.ports[5173] = [70001]
        with patch.object(ctl.urllib.request, 'build_opener') as network:
            self.assertFalse(self.original_ready(self.control.job()))
        network.assert_not_called()
        self.control.validate_job(config, self.control.job())

    def test_parse_job_ignores_nested_domain_pid(self):
        self.install()
        job = ctl.parse_job(self.system.render())
        self.assertNotIn('pid', job)
        self.assertEqual(job['arguments'], self.system.definition['ProgramArguments'])


if __name__ == '__main__':
    unittest.main()
