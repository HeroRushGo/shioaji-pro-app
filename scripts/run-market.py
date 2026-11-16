"""Supervise the isolated market-only dev stack; never manages other servers."""
import argparse
import fcntl
import hashlib
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import json
import tempfile

BINARY_SHA256 = "52907491366170a430991e3b6701a21718263a04b48b71649de0e4961bcb5b92"
PORTS = (21324, 21323, 5173)


def clean_environment(source):
    return {key: source[key] for key in ("HOME", "PATH", "LANG", "TMPDIR", "TRADING_LOG_ROOT") if key in source}


def check_ports():
    sockets = []
    try:
        for port in PORTS:
            probe = socket.socket()
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sockets.append(probe)
            probe.bind(("127.0.0.1", port))
    finally:
        for probe in sockets:
            probe.close()


def stop_children(children, grace=8):
    # Each recorded child is the leader of a new process group. No port-based
    # kill, daemon registry stop, pkill, or persisted PID is used.
    def group_alive(pid):
        try:
            os.killpg(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            # macOS process policy can return EPERM for an already-gone
            # group. Check only public PGIDs; never infer absence from EPERM.
            groups = subprocess.check_output(['/bin/ps', '-axo', 'pgid='], text=True)
            return pid in {int(value) for value in groups.split()}
    def send(pid, signum):
        try:
            os.killpg(pid, signum)
        except ProcessLookupError:
            pass
        except PermissionError:
            if group_alive(pid):
                raise
    for child in reversed(children):
        send(child.pid, signal.SIGTERM)
    deadline = time.monotonic() + grace
    remaining = {child.pid for child in children if group_alive(child.pid)}
    while remaining and time.monotonic() < deadline:
        for child in children:
            child.poll()
        time.sleep(.02)
        remaining = {pid for pid in remaining if group_alive(pid)}
    # A group may outlive its leader. Escalation depends on the group, never
    # merely Popen.wait() returning for the already-exited leader.
    for pid in remaining:
        send(pid, signal.SIGKILL)
    for child in children:
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            send(child.pid, signal.SIGKILL)
            child.wait(timeout=2)


def wait_backend(children, authorization):
    for _ in range(120):
        if any(child.poll() is not None for child in children):
            raise RuntimeError("owned child exited")
        try:
            with urllib.request.urlopen("http://127.0.0.1:21324/api/v1/health", timeout=2) as response:
                data = json.load(response)
            if data.get("version") != "1.7.11":
                raise RuntimeError("unexpected backend")
            if data.get("status") == "healthy" and not data.get("token_stale") and not data.get("session_recovering"):
                request = urllib.request.Request("http://127.0.0.1:21324/api/v1/data/contracts/2330?security_type=STK&region=TW", headers={"Authorization": authorization})
                with urllib.request.urlopen(request, timeout=5) as response:
                    contract = json.load(response)
                if contract.get("code") == "2330":
                    return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError("backend startup timeout")


def run(vault):
    repo = Path(__file__).resolve().parent.parent
    env = clean_environment(os.environ)
    root = Path(env.get("TRADING_LOG_ROOT", "")).resolve()
    if not env.get("TRADING_LOG_ROOT") or Path.cwd().resolve() != root or root.stat().st_mode & 0o077:
        raise RuntimeError("log custody wrapper required")
    os.umask(0o077)
    # A dedicated CLI home isolates its token pool, sockets and daemon metadata.
    home = root / "pro-web-state"
    home.mkdir(mode=0o700, exist_ok=True)
    if home.is_symlink() or home.stat().st_mode & 0o077:
        raise RuntimeError("private state directory required")
    if (root / ".env").exists():
        raise RuntimeError("vendor working directory must not contain .env")
    lock = (home / "stack.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    check_ports()
    binary = repo / "src-tauri/binaries/shioaji-aarch64-apple-darwin"
    if sys.platform != "darwin" or os.uname().machine != "arm64" or hashlib.sha256(binary.read_bytes()).hexdigest() != BINARY_SHA256:
        raise RuntimeError("verified Shioaji 1.7.11 macOS arm64 binary required; see runbook")
    if (repo / "SHIOAJI_VERSION").read_text().strip() != "v1.7.11":
        raise RuntimeError("sidecar pin changed; review launcher before use")
    node = shutil.which("node", path=env.get("PATH"))
    if not node:
        raise RuntimeError("Node 22.12+ required")
    vite = repo / "node_modules/vite/bin/vite.js"
    if not vite.is_file():
        raise RuntimeError("install locked frontend dependencies first")
    # This loader validates the receipt and parses exactly those verified bytes;
    # ambient SJ_*/SHIOAJI_* values are never the source of authority.
    sys.path.insert(0, str(vault / "scripts/neo-client"))
    from neo_client.core.config import load_shioaji_credentials
    api_key, secret_key = load_shioaji_credentials(environ={})
    private = dict(env, SJ_API_KEY=api_key, SJ_SEC_KEY=secret_key)
    # The pinned CLI can report healthy for a reused token whose Solace session
    # is not established. A fresh private SDK home avoids that reuse entirely.
    session_home = Path(tempfile.mkdtemp(prefix="sdk-", dir=home))
    backend_env = dict(private, SJ_HOME_PATH=str(session_home), SJ_LOG_PATH=str(root / "log/shioaji.log"),
                       SJ_HTTP_ADDR="127.0.0.1:21324", SJ_HTTP_AUTH="true", SJ_UDS_DISABLE="true")
    log_path = root / "log/pro-web-market.log"
    if log_path.is_symlink():
        raise RuntimeError("log symlink refused")
    log = log_path.open("a")
    os.chmod(log_path, 0o600)
    children = []
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    def start(argv, child_env, cwd):
        child = subprocess.Popen(argv, env=child_env, cwd=cwd, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=log, start_new_session=True)
        children.append(child)
        return child
    try:
        start([str(binary), "server", "start", "--production", "--auth", "--no-open"], backend_env, root)
        wait_backend(children, f"Bearer {api_key}:{secret_key}")
        # Assert production metadata without requesting accounts or credentials.
        with urllib.request.urlopen("http://127.0.0.1:21324/api/v1/info", timeout=5) as response:
            info = json.load(response)
        if info.get("version") != "1.7.11" or info.get("simulation") is not False:
            raise RuntimeError("production market backend required")
        start([node, str(repo / "scripts/market-gateway.mjs")], dict(private, PRO_MARKET_STATE=str(home / "watchlists.json")), root)
        start([node, str(vite), "--mode", "market", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], env, repo)
        print(f"Pro Web 行情唯讀: http://127.0.0.1:5173/ (supervisor {os.getpid()})", flush=True)
        print("停止：在此終端按 Ctrl-C；僅回收本次三個服務。", flush=True)
        while all(child.poll() is None for child in children):
            time.sleep(1)
        raise RuntimeError("owned child exited; stack rolled back")
    finally:
        stop_children(children)
        log.close()
        lock.close()
        shutil.rmtree(session_home)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault", type=Path, required=True)
    args = parser.parse_args()
    try:
        run(args.vault.resolve())
    except KeyboardInterrupt:
        print("Pro Web 行情服務已停止。")
    except Exception:
        # Credential-loader/SDK exceptions can contain sensitive context.
        # Keep diagnostic details in protected local logs, never terminal output.
        print("Pro Web 啟動失敗；請檢查 binary、receipt、隔離埠與受保護服務 log。", file=sys.stderr)
        sys.exit(1)
