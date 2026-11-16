"""On-demand, user-scoped launchd control for the market-only Pro Web stack."""
import argparse
import base64
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import pwd
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request

LABEL = 'com.user.shioaji-pro-web'
MARKER = 'shioaji-pro-web-launchd-v1'
PORTS = (5173, 21323, 21324)


class ControlError(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def private(path, directory=False):
    if path.is_symlink():
        raise ControlError('managed symlink refused')
    stat = path.stat()
    if stat.st_uid != os.getuid() or stat.st_mode & 0o077 or (directory and not path.is_dir()) or (not directory and not path.is_file()):
        raise ControlError('managed path must be private and user-owned')


def atomic(path, data, mode=0o600):
    if path.is_symlink():
        raise ControlError('managed symlink refused')
    fd, temporary = tempfile.mkstemp(prefix='.pro-web-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


@dataclass(frozen=True)
class Settings:
    home: Path
    repo: Path
    vault: Path
    node: Path

    @property
    def root(self): return self.home / '.trading/pro-web-control'
    @property
    def config(self): return self.root / 'config.json'
    @property
    def plist(self): return self.home / 'Library/LaunchAgents' / (LABEL + '.plist')
    @property
    def command(self): return self.home / '.local/bin/pro-web-ctl'
    @property
    def logroot(self): return self.home / '.trading/vendor-logs'
    @property
    def log(self): return self.logroot / 'log/pro-web-launchd.log'
    @property
    def python(self): return self.vault / 'scripts/neo-client/.venv/bin/python'
    @property
    def target(self): return f'gui/{os.getuid()}/{LABEL}'


def parse_job(text):
    result = {}
    for key in ['state', 'pid', 'last exit code', 'program', 'path']:
        match = re.search(r'^\t' + re.escape(key) + r' = (.*)$', text, re.M)
        if match: result[key] = match.group(1)
    match = re.search(r'^\targuments = \{\n(.*?)^\t\}', text, re.M | re.S)
    result['arguments'] = [line.strip() for line in match.group(1).splitlines() if line.strip()] if match else []
    return result


def resolve_settings():
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    root = home / '.trading/pro-web-control'
    source = Path(__file__).resolve()
    if source.parent == root:
        private(root, True); private(root / 'config.json')
        config = json.loads((root / 'config.json').read_text())
        if config.get('managed') != MARKER: raise ControlError('unknown installation')
        return Settings(home, Path(config['repo']), Path(config['vault']), Path(config['node']))
    source_repo = source.parent.parent
    common = subprocess.check_output(['/usr/bin/git', '-C', str(source_repo), 'rev-parse', '--git-common-dir'], text=True).strip()
    repo = (source_repo / common).resolve().parent
    node = shutil.which('node', path='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')
    if not node: raise ControlError('Node 22.12+ required')
    return Settings(home, repo, home / 'Documents/Trading', Path(node))


class Controller:
    def __init__(self, settings, runner=subprocess.run, clock=time.monotonic, sleep=time.sleep):
        self.s = settings; self.run = runner; self.clock = clock; self.sleep = sleep

    def execute(self, argv, **kwargs):
        return self.run([str(value) for value in argv], capture_output=True, text=True, **kwargs)

    def lc(self, *args): return self.execute(['/bin/launchctl', *args])

    def job(self):
        result = self.lc('print', self.s.target)
        if result.returncode == 0: return parse_job(result.stdout)
        missing = f'Could not find service "{LABEL}" in domain for user gui: {os.getuid()}'
        if result.returncode == 113 and missing in result.stderr: return None
        raise ControlError('cannot inspect launchd job; no absent-job assumption made')

    def load(self):
        private(self.s.root, True); private(self.s.config); private(self.s.plist)
        config = json.loads(self.s.config.read_text())
        if config.get('managed') != MARKER or config['repo'] != str(self.s.repo) or config['vault'] != str(self.s.vault) or config['node'] != str(self.s.node):
            raise ControlError('installation identity mismatch')
        for prefix, suffix in [('controller', '.py'), ('job', '.zsh')]:
            sha = config[prefix + 'Sha256']
            if not re.fullmatch('[a-f0-9]{64}', sha): raise ControlError('invalid installation digest')
            path = self.s.root / f'{prefix}-{sha}{suffix}'
            private(path)
            if digest(path.read_bytes()) != sha: raise ControlError('installed code changed')
        expected = self.definition(config)
        if plistlib.loads(self.s.plist.read_bytes()) != expected: raise ControlError('plist changed or foreign job')
        private(self.s.command)
        if self.s.command.read_bytes() != self.command_bytes(config): raise ControlError('managed command changed')
        private(self.s.root / 'no-rc', True)
        if any((self.s.root / 'no-rc').iterdir()): raise ControlError('private rc directory must be empty')
        private(self.s.log)
        return config

    def command_bytes(self, config):
        controller = self.s.root / ('controller-' + config['controllerSha256'] + '.py')
        return ('#!/bin/zsh -f\n# managed by ' + MARKER + '\nexec ' + shlex.quote(str(self.s.python)) + ' -I ' + shlex.quote(str(controller)) + ' "$@"\n').encode()

    def definition(self, config):
        job = self.s.root / ('job-' + config['jobSha256'] + '.zsh')
        env = {'HOME': str(self.s.home), 'PATH': f'{self.s.node.parent}:/usr/bin:/bin:/usr/sbin:/sbin',
               'LANG': 'en_US.UTF-8', 'TRADING_VAULT': str(self.s.vault), 'TRADING_LOG_ROOT': str(self.s.logroot),
               'ZDOTDIR': str(self.s.root / 'no-rc')}
        args = ['/bin/zsh', '-f', str(job), str(self.s.repo)]
        return {'Label': LABEL, 'ProgramArguments': args, 'EnvironmentVariables': env, 'RunAtLoad': False, 'KeepAlive': False,
                'WorkingDirectory': str(self.s.logroot), 'Umask': 63, 'ExitTimeOut': 45, 'AbandonProcessGroup': False,
                'ProcessType': 'Interactive', 'StandardOutPath': str(self.s.log), 'StandardErrorPath': str(self.s.log)}

    def validate_job(self, config, job):
        if job and (job.get('program') != '/bin/zsh' or job.get('arguments') != self.definition(config)['ProgramArguments']
                    or job.get('path') != str(self.s.plist)):
            raise ControlError('loaded job is not this managed definition')

    @contextmanager
    def lock(self):
        self.s.root.mkdir(mode=0o700, parents=True, exist_ok=True); private(self.s.root, True)
        path = self.s.root / 'control.lock'
        if path.is_symlink(): raise ControlError('lock symlink refused')
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as stream:
            metadata = os.fstat(stream.fileno())
            if metadata.st_uid != os.getuid() or metadata.st_mode & 0o077 or not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                raise ControlError('lock must be private, regular and user-owned')
            fcntl.flock(stream, fcntl.LOCK_EX)
            yield

    def listeners(self):
        result = {}
        for port in PORTS:
            output = self.execute(['/usr/sbin/lsof', '-tnP', f'-iTCP:{port}', '-sTCP:LISTEN'])
            if output.returncode not in (0, 1) or output.stderr.strip():
                raise ControlError('cannot inspect Pro listener ownership')
            result[port] = sorted({int(value) for value in output.stdout.split() if value.isdigit()})
        return result

    def descendant(self, pid, root):
        for _ in range(12):
            if pid == root: return True
            if pid <= 1: return False
            value = self.execute(['/bin/ps', '-o', 'ppid=', '-p', str(pid)]).stdout.strip()
            if not value.isdigit(): return False
            pid = int(value)
        return False

    def ready(self, job):
        if not job or not job.get('pid', '').isdigit(): return False
        pid = int(job['pid']); listeners = self.listeners()
        if not all(pids and all(self.descendant(p, pid) for p in pids) for pids in listeners.values()): return False
        try:
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *_args, **_kwargs): return None
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            def get(path):
                with opener.open('http://127.0.0.1:5173' + path, timeout=3) as response: return json.load(response)
            health = get('/api/v1/health'); info = get('/api/v1/info')
            contract = get('/api/v1/data/contracts/2330?security_type=STK&region=TW')
            with opener.open('http://127.0.0.1:5173/', timeout=3) as response:
                html = response.headers.get_content_type() == 'text/html' and b'<html' in response.read(8192).lower()
            return html and health.get('status') == 'healthy' and not health.get('token_stale') and not health.get('session_recovering') and info.get('version') == '1.7.11' and info.get('simulation') is False and contract.get('code') == '2330'
        except Exception: return False

    def _stop(self, config, timeout=35):
        job = self.job(); self.validate_job(config, job)
        if job and job.get('pid'):
            if self.lc('kill', 'SIGTERM', self.s.target).returncode:
                raise ControlError('launchd TERM failed')
        deadline = self.clock() + timeout
        while self.clock() < deadline:
            job = self.job(); self.validate_job(config, job)
            if not (job and job.get('pid')):
                if not any(self.listeners().values()): return
            self.sleep(.25)
        raise ControlError('job or ports have not stopped; no forced kill performed')

    def _start(self, config, timeout=180):
        job = self.job(); self.validate_job(config, job)
        if not job: raise ControlError('job not registered; run install')
        if self.ready(job): return
        if not job.get('pid'):
            if any(self.listeners().values()): raise ControlError('Pro ports occupied outside this job; refusing takeover')
            if self.lc('kickstart', self.s.target).returncode: raise ControlError('launchd kickstart failed')
        started = self.clock(); deadline = started + timeout
        try:
            while self.clock() < deadline:
                job = self.job(); self.validate_job(config, job)
                if self.ready(job): return
                if not job: raise ControlError('job was unloaded during startup')
                # launchctl can briefly retain the previous exit status before
                # publishing the newly kicked job's PID.
                if not job.get('pid') and 'last exit code' in job and self.clock() - started >= 2:
                    raise ControlError('job exited before readiness')
                self.sleep(.5)
            raise ControlError('Pro startup timeout')
        except Exception:
            try: self._stop(config)
            except ControlError as cleanup:
                raise ControlError('startup failed and graceful cleanup needs attention; ' + str(cleanup)) from None
            raise

    def start(self):
        with self.lock(): self._start(self.load())
    def stop(self):
        with self.lock(): self._stop(self.load())
    def restart(self):
        with self.lock():
            config = self.load(); self._stop(config); self._start(config)

    def install(self, controller_source, job_source):
        with self.lock():
            if self.s.config.is_symlink(): raise ControlError('config symlink refused')
            recovery = self.s.root / 'recovery.json'
            if recovery.exists() or recovery.is_symlink(): raise ControlError('pending installation recovery; inspect private recovery.json before changing the job')
            controller_bytes = controller_source.read_bytes(); job_bytes = job_source.read_bytes()
            config = {'managed': MARKER, 'repo': str(self.s.repo), 'vault': str(self.s.vault), 'node': str(self.s.node),
                      'controllerSha256': digest(controller_bytes), 'jobSha256': digest(job_bytes)}
            old_job = self.job()
            old_config = self.load() if self.s.config.exists() else None
            if old_job:
                if not old_config: raise ControlError('foreign loaded job')
                self.validate_job(old_config, old_job)
                if old_config == config: return
                if old_job.get('pid'): raise ControlError('stop before upgrading controller')
            for path in [self.s.plist, self.s.command]:
                if path.exists() or path.is_symlink():
                    if not old_config: raise ControlError('foreign install artifact')
                    private(path)
            self.s.command.parent.mkdir(parents=True, exist_ok=True)
            self.s.plist.parent.mkdir(parents=True, exist_ok=True)
            no_rc = self.s.root / 'no-rc'; no_rc.mkdir(mode=0o700, exist_ok=True); private(no_rc, True)
            if any(no_rc.iterdir()): raise ControlError('private rc directory must be empty')
            custody_env = {'HOME': str(self.s.home), 'PATH': f'{self.s.node.parent}:/usr/bin:/bin:/usr/sbin:/sbin', 'TRADING_LOG_ROOT': str(self.s.logroot), 'ZDOTDIR': str(no_rc)}
            preflight = self.execute(['/bin/zsh', '-f', self.s.vault / 'ops/workstation-vendor-run.zsh', '/usr/bin/true'], env=custody_env)
            if preflight.returncode: raise ControlError('log custody preflight failed')
            if self.s.log.is_symlink(): raise ControlError('log symlink refused')
            self.s.log.touch(mode=0o600, exist_ok=True); os.chmod(self.s.log, 0o600)
            for prefix, data, suffix in [('controller', controller_bytes, '.py'), ('job', job_bytes, '.zsh')]:
                path = self.s.root / f'{prefix}-{digest(data)}{suffix}'
                if path.exists():
                    private(path)
                    if path.read_bytes() != data: raise ControlError('immutable artifact mismatch')
                else: atomic(path, data)
            command = self.command_bytes(config)
            paths = [self.s.config, self.s.command, self.s.plist]
            saved = {p: (p.read_bytes(), p.stat().st_mode & 0o777) if p.exists() else None for p in paths}
            recovery_data = {'managed': MARKER, 'newConfig': config,
                             'previous': {str(p): {'bytesBase64': base64.b64encode(v[0]).decode(), 'mode': v[1]} if v else None for p, v in saved.items()}}
            atomic(recovery, json.dumps(recovery_data, indent=2).encode())
            if old_job and self.lc('bootout', self.s.target).returncode: raise ControlError('cannot unload old idle definition; recovery snapshot retained')
            bootstrapped = False
            try:
                atomic(self.s.plist, plistlib.dumps(self.definition(config)))
                if self.lc('bootstrap', f'gui/{os.getuid()}', str(self.s.plist)).returncode: raise ControlError('bootstrap failed')
                bootstrapped = True
                new_job = self.job(); self.validate_job(config, new_job)
                if not new_job or new_job.get('pid'): raise ControlError('install must register an idle job')
                atomic(self.s.config, json.dumps(config, indent=2).encode())
                atomic(self.s.command, command, 0o700)
            except Exception:
                try:
                    remaining = self.job()
                    if remaining:
                        if not bootstrapped: raise ControlError('registration is not owned by this attempt')
                        self.validate_job(config, remaining)
                        if self.lc('bootout', self.s.target).returncode or self.job() is not None:
                            raise ControlError('cannot unload new definition')
                except ControlError:
                    raise ControlError('install rollback could not safely unload; artifacts and private recovery.json retained') from None
                for path, previous in saved.items():
                    if previous: atomic(path, *previous)
                    else: path.unlink(missing_ok=True)
                if old_job and self.lc('bootstrap', f'gui/{os.getuid()}', str(self.s.plist)).returncode:
                    raise ControlError('install rollback needs attention; previous files restored, recovery.json retained')
                recovery.unlink()
                raise
            recovery.unlink()

    def uninstall(self):
        with self.lock():
            config = self.load(); self._stop(config)
            if self.job() and self.lc('bootout', self.s.target).returncode: raise ControlError('bootout failed')
            self.s.plist.unlink(); self.s.command.unlink(); self.s.config.unlink()
            # Keep lock inode, immutable revisions and private logs for audit.

    def status(self):
        config = self.load(); job = self.job(); self.validate_job(config, job)
        return {'label': LABEL, 'registered': job is not None, 'state': job.get('state') if job else None,
                'pid': job.get('pid') if job else None, 'ready': self.ready(job), 'repo': str(self.s.repo),
                'listeners': self.listeners(), 'log': str(self.s.log), 'url': 'http://127.0.0.1:5173/'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['plan', 'install', 'start', 'stop', 'restart', 'status', 'log', 'uninstall'])
    parser.add_argument('-f', '--follow', action='store_true')
    args = parser.parse_args(); settings = resolve_settings(); ctl = Controller(settings)
    if args.command == 'plan':
        print(json.dumps({'repo': str(settings.repo), 'label': LABEL, 'RunAtLoad': False, 'KeepAlive': False, 'ports': PORTS, 'log': str(settings.log)}, indent=2)); return
    if args.command == 'install':
        source = Path(__file__).resolve()
        job_source = source.parent / 'pro-web-launchd.zsh'
        if source.parent == settings.root:
            config = ctl.load(); job_source = settings.root / ('job-' + config['jobSha256'] + '.zsh')
        ctl.install(source, job_source)
        print('Pro Web 已登記；不自動啟動。使用 pro-web-ctl start。'); return
    if args.command == 'status': print(json.dumps(ctl.status(), ensure_ascii=False, indent=2)); return
    if args.command == 'log':
        ctl.load(); private(settings.log)
        os.execv('/usr/bin/tail', ['tail', '-n', '60', *(['-f'] if args.follow else []), str(settings.log)])
    getattr(ctl, args.command)()
    print({'start': 'Pro Web 已就緒：http://127.0.0.1:5173/', 'stop': 'Pro Web 已停止。', 'restart': 'Pro Web 已重啟。', 'uninstall': 'Pro Web launchd 已卸載。'}[args.command])


if __name__ == '__main__':
    try: main()
    except ControlError as error:
        print('Pro Web: ' + str(error) + '. See plan/status or the supervisor log.', file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError):
        # Do not print raw subprocess output or environment/credential errors.
        print('Pro Web 控制失敗；請檢查安裝、私有路徑、job 定義及埠占用。使用 plan/status 或 supervisor log。', file=sys.stderr)
        sys.exit(1)
