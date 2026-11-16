"""Offline neo reader export. No server, SDK, ingest, or writable DB connection.

Run with the existing neo-client venv's ``python -P -B``. A single JSON request
arrives on stdin; stdout is a single versioned JSON response. Only past-day
session/bars/VP GETs are constructed here. Every numerical sample is requested
at its exact HH:mm:00 Taipei cutoff, never relabelled from a completed minute.
"""
from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from zoneinfo import ZoneInfo

ADAPTER_VERSION = "neo-reader-prefix-v1"
TAIPEI = ZoneInfo("Asia/Taipei")
SAMPLES = frozenset((1, 5, 15, 30, 60))


def check_request(value: object) -> dict:
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise ValueError("unsupported export request schema")
    repo = Path(value.get("neoRepo", "")).resolve(strict=True)
    if not (repo / "neo_client/dashboard/reader_app.py").is_file():
        raise ValueError("neoRepo does not contain the reviewed reader")
    expected = value.get("neoCommit")
    if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{40}", expected):
        raise ValueError("neoCommit must pin a full commit")
    symbols = value.get("symbols")
    dates = value.get("dates")
    if not isinstance(symbols, list) or not 1 <= len(symbols) <= 20:
        raise ValueError("symbols must contain 1 to 20 identities")
    if not isinstance(dates, list) or not 1 <= len(dates) <= 10:
        raise ValueError("dates must contain 1 to 10 past dates")
    for symbol in symbols:
        if not isinstance(symbol, str) or not re.fullmatch(r"\d{4}", symbol):
            raise ValueError("invalid symbol")
    today = dt.datetime.now(TAIPEI).date()
    for date in dates:
        if not isinstance(date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            raise ValueError("invalid date")
        if dt.date.fromisoformat(date) >= today:
            raise ValueError("only dates before today in Asia/Taipei may be exported")
    sampling = value.get("samplingMinutes", 30)
    if isinstance(sampling, bool) or sampling not in SAMPLES:
        raise ValueError("unsupported samplingMinutes")
    stores = []
    for key in ("dbPath", "shioajiDbPath"):
        candidate = value.get(key)
        if candidate is None and key == "shioajiDbPath":
            stores.append(None)
            continue
        if not isinstance(candidate, str) or not candidate:
            raise ValueError(f"{key} is required")
        raw = Path(candidate)
        # A miss must remain a miss; DuckDB must never create a new store here.
        if raw.is_symlink() or not raw.is_file():
            raise ValueError(f"{key} must name an existing regular store")
        stores.append(raw.resolve(strict=True))
    return {
        "repo": repo, "neoCommit": expected,
        "symbols": sorted(set(symbols)), "dates": sorted(set(dates)),
        "samplingMinutes": sampling, "stores": stores,
    }


def git_state(repo: Path) -> str:
    commit = subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True,
        stderr=subprocess.DEVNULL,
    ).strip()
    dirty = subprocess.check_output(
        ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", str(repo), "status", "--porcelain", "--untracked-files=normal",
         "--", "neo_client", "pyproject.toml", "uv.lock"],
        text=True, stderr=subprocess.DEVNULL,
    ).strip()
    if dirty:
        raise ValueError("neo-client source or dependency lock is dirty")
    return commit


def store_fingerprint(store: Path, alias: str) -> dict:
    def stat(path):
        value = path.stat()
        if path.is_symlink() or not path.is_file():
            raise ValueError("store fingerprint requires regular files")
        return {"device": value.st_dev, "inode": value.st_ino, "size": value.st_size,
                "mtimeNs": str(value.st_mtime_ns), "ctimeNs": str(value.st_ctime_ns)}
    real = store.resolve(strict=True)
    wal = Path(f"{real}.wal")
    return {"alias": alias, "filename": real.name, "realPathSha256": hashlib.sha256(str(real).encode()).hexdigest(),
            **stat(real), "wal": stat(wal) if wal.exists() else None}


def install_guards(allowed_stores: list[Path | None]):
    """Tripwires supplement the reader's structural read-only/no-fetch contract."""
    allowed = frozenset(str(p.resolve()) for p in allowed_stores if p is not None)
    counters = {"readOnlyConnections": 0, "readStores": set()}
    write_flags = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
    secret_parts = frozenset((".ssh", ".aws", ".gnupg", ".shioaji", "secrets.d"))

    def audit(event, args):
        if event in ("socket.connect", "socket.bind", "socket.getaddrinfo"):
            raise PermissionError("offline reader export forbids network access")
        if event in ("subprocess.Popen", "os.system", "os.posix_spawn", "os.exec"):
            raise PermissionError("offline reader export forbids subprocesses")
        if event in ("os.remove", "os.rename", "os.rmdir", "os.mkdir", "os.chmod", "os.truncate"):
            raise PermissionError("offline reader export forbids filesystem writes")
        if event == "open":
            filename, mode, flags = args
            if isinstance(filename, (str, bytes, os.PathLike)):
                path = Path(os.fsdecode(filename))
                if (any(part.lower() in secret_parts for part in path.parts)
                        or path.name.lower().startswith(".env")
                        or path.name.lower() in (".netrc", ".credentials.json")
                        or any(part.lower() == ".config" and index + 1 < len(path.parts)
                               and path.parts[index + 1].lower() in ("fubon-neo", "gh")
                               for index, part in enumerate(path.parts))
                        or path.suffix.lower() in (".p12", ".pfx")):
                    raise PermissionError("offline reader export forbids credential files")
            if (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
                    isinstance(flags, int) and flags & write_flags):
                raise PermissionError("offline reader export forbids filesystem writes")

    sys.addaudithook(audit)
    import duckdb
    connect = duckdb.connect

    def read_only_connect(database=":memory:", *args, **kwargs):
        if args or kwargs.get("read_only") is not True:
            raise PermissionError("neo export requires read_only=True on every DB connection")
        resolved = str(Path(database).resolve())
        if resolved not in allowed:
            raise PermissionError("neo export attempted an unapproved database")
        counters["readOnlyConnections"] += 1
        counters["readStores"].add(resolved)
        return connect(database, **kwargs)

    duckdb.connect = read_only_connect
    return counters


def source_fingerprint(repo: Path) -> str:
    """Pin Python source before/after queries, including later lazy imports."""
    for name, module in sorted(sys.modules.items()):
        filename = getattr(module, "__file__", None)
        if name == "neo_client" or name.startswith("neo_client."):
            if not filename:
                continue
            source = Path(filename).resolve(strict=True)
            if not source.is_relative_to(repo / "neo_client"):
                raise ValueError("neo_client imports escaped the pinned checkout")
    sources = []
    for source in sorted((repo / "neo_client").rglob("*.py")):
        if source.is_symlink() or not source.resolve(strict=True).is_relative_to(repo / "neo_client"):
            raise ValueError("neo source tree contains a symlink escape")
        sources.append((str(source.relative_to(repo)), hashlib.sha256(source.read_bytes()).hexdigest()))
    return hashlib.sha256(json.dumps(sources, separators=(",", ":")).encode()).hexdigest()


def sample_times(step: int) -> list[str]:
    minutes = list(range(9 * 60, 13 * 60 + 31, step))
    if minutes[-1] != 13 * 60 + 30:
        minutes.append(13 * 60 + 30)
    return [f"{minute // 60:02}:{minute % 60:02}" for minute in minutes]


async def read_samples(app, config: dict) -> list[dict]:
    import httpx
    results = []
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://offline-reader.invalid", trust_env=False,
        follow_redirects=False, timeout=120,
    ) as client:
        async def get(route, params):
            response = await client.get(route, params=params)
            if response.status_code not in (200, 404):
                raise ValueError(f"read-only endpoint returned HTTP {response.status_code}")
            return {"status": response.status_code, "body": response.json()}

        for symbol in config["symbols"]:
            for date in config["dates"]:
                session = await get("/api/session", {"symbol": symbol, "date": date})
                samples = []
                for time in sample_times(config["samplingMinutes"]):
                    params = {"date": date, "as_of": f"{time}:00"}
                    bars = await get(f"/api/bars/{symbol}", {**params, "interval": 60})
                    vp = await get(f"/api/vp/{symbol}", params)
                    samples.append({"time": time, "bars": bars, "vp": vp})
                session_after = await get("/api/session", {"symbol": symbol, "date": date})
                results.append({"symbol": symbol, "date": date, "session": session,
                                "sessionAfter": session_after, "samples": samples})
    return results


def main():
    # Discard inherited SDK/auth/proxy variables before importing any neo code.
    clean_env = {key: os.environ[key] for key in ("HOME", "PATH", "LANG", "LC_ALL", "TZ") if key in os.environ}
    os.environ.clear()
    os.environ.update(clean_env)
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    sys.dont_write_bytecode = True
    config = check_request(json.load(sys.stdin))
    repo = config["repo"]
    if git_state(repo) != config["neoCommit"]:
        raise ValueError("neo-client HEAD differs from the requested pin")
    fingerprints = {str(store): store_fingerprint(store, alias)
                    for alias, store in zip(("store_a", "store_b"), config["stores"]) if store is not None}
    # Install after git checks (which need subprocess), before importing neo.
    counters = install_guards(config["stores"])
    with contextlib.redirect_stdout(sys.stderr):
        import neo_client
        if Path(neo_client.__file__).resolve() != repo / "neo_client/__init__.py":
            raise ValueError("venv neo_client.__file__ does not match neoRepo")
        from neo_client.dashboard.reader_app import create_reader_app
        app = create_reader_app(
            db_path=config["stores"][0], shioaji_db_path=config["stores"][1], live=None,
        )
        ctx = app.state.ctx
        if not ctx.reader_mode or ctx.allow_outbound or ctx.live_engine() is not None:
            raise ValueError("reader construction violated offline observation mode")
        fingerprint_before = source_fingerprint(repo)
        results = asyncio.run(read_samples(app, config))
    fingerprint = source_fingerprint(repo)
    if fingerprint != fingerprint_before:
        raise ValueError("neo source changed while exporting")
    read_stores = []
    for store in sorted(counters["readStores"]):
        before = fingerprints[store]
        if store_fingerprint(Path(store), before["alias"]) != before:
            raise ValueError("market database or WAL changed while exporting; retry a stable past-day snapshot")
        read_stores.append(before)
    # No git subprocess after the guard: the parent independently checks HEAD
    # and cleanliness after this process finishes and before publishing.
    return {
        "schemaVersion": 1, "adapterVersion": ADAPTER_VERSION,
        "neoCommit": config["neoCommit"], "sourceFingerprint": fingerprint,
        "evidence": {
            "transport": "offline_asgi", "readerModule": "neo_client.dashboard.reader_app",
            "packageVerified": True, "readerMode": True, "allowOutbound": False,
            "liveEngine": False, "databaseMode": "read_only",
            "networkGuard": True, "filesystemWriteGuard": True, "subprocessGuard": True,
            "sourceStable": True, "databasesStable": True,
            "readOnlyConnections": counters["readOnlyConnections"], "stores": read_stores,
        },
        "results": results,
    }


if __name__ == "__main__":
    try:
        print(json.dumps(main(), ensure_ascii=False, allow_nan=False, separators=(",", ":")))
    except Exception as error:
        print(f"neo offline export failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
