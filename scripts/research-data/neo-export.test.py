"""Exporter guard tests: synthetic clients only; never open a real market store."""
import asyncio
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest

HELPER = Path(__file__).with_name("neo-export.py")
spec = importlib.util.spec_from_file_location("neo_export", HELPER)
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class ExporterTests(unittest.TestCase):
    def test_store_and_wal_fingerprints_detect_repair_without_exposing_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Path(directory) / "market.bin"
            store.write_bytes(b"old-data")
            before = exporter.store_fingerprint(store, "store_a")
            self.assertEqual(before["alias"], "store_a")
            self.assertEqual(before["filename"], "market.bin")
            self.assertEqual(before["wal"], None)
            self.assertNotIn(directory, json.dumps(before))
            self.assertEqual(exporter.store_fingerprint(store, "store_a"), before)
            Path(f"{store}.wal").write_bytes(b"new committed state")
            with_wal = exporter.store_fingerprint(store, "store_a")
            self.assertNotEqual(with_wal, before)
            self.assertEqual(with_wal["wal"]["size"], 19)
            store.write_bytes(b"a different snapshot")
            self.assertNotEqual(exporter.store_fingerprint(store, "store_a"), with_wal)

    def test_exact_cutoff_request_shapes_without_network(self):
        calls = []

        class Client:
            def __init__(self, **kwargs):
                self.kwargs = kwargs
                self_test.assertEqual(kwargs["trust_env"], False)
                self_test.assertEqual(kwargs["follow_redirects"], False)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def get(self, route, params):
                calls.append((route, params))
                return types.SimpleNamespace(status_code=404, json=lambda: {"detail": "no ticks"})

        self_test = self
        previous = sys.modules.get("httpx")
        sys.modules["httpx"] = types.SimpleNamespace(AsyncClient=Client, ASGITransport=lambda app: app)
        try:
            results = asyncio.run(exporter.read_samples(object(), {
                "symbols": ["2330"], "dates": ["2026-11-13"], "samplingMinutes": 30,
            }))
        finally:
            if previous is None:
                del sys.modules["httpx"]
            else:
                sys.modules["httpx"] = previous
        self.assertEqual(len(calls), 22)
        self.assertEqual(calls[0], ("/api/session", {"symbol": "2330", "date": "2026-11-13"}))
        self.assertEqual(calls[1], ("/api/bars/2330", {"date": "2026-11-13", "as_of": "09:00:00", "interval": 60}))
        self.assertEqual(calls[-2], ("/api/vp/2330", {"date": "2026-11-13", "as_of": "13:30:00"}))
        self.assertEqual(calls[-1], calls[0])
        self.assertEqual(len(results[0]["samples"]), 10)

    def test_network_filesystem_and_writable_database_tripwires(self):
        # Audit hooks cannot be removed, so the guard test owns a fresh process.
        code = r'''
import importlib.util, json, pathlib, socket, subprocess, sys, types
spec = importlib.util.spec_from_file_location("neo_export", sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
sys.modules["duckdb"] = types.SimpleNamespace(connect=lambda database, **kw: {"database":database, **kw})
guard = module.install_guards([pathlib.Path("/tmp/approved-market-store.duckdb")])
import duckdb
checks = {}
for name, operation in {
    "network": lambda: socket.create_connection(("127.0.0.1", 8788)),
    "write": lambda: open("/tmp/neo-export-must-not-write", "w"),
    "credential": lambda: open("/tmp/.shioaji/token_pool/example"),
    "db_write": lambda: duckdb.connect("/tmp/approved-market-store.duckdb"),
    "wrong_db": lambda: duckdb.connect("/tmp/unapproved.duckdb", read_only=True),
    "subprocess": lambda: subprocess.run([sys.executable, "-V"]),
}.items():
    try: operation()
    except PermissionError: checks[name] = True
    else: checks[name] = False
checks["read"] = duckdb.connect("/tmp/approved-market-store.duckdb", read_only=True)["read_only"]
checks["connections"] = guard["readOnlyConnections"]
print(json.dumps(checks))
'''
        result = subprocess.run([sys.executable, "-P", "-B", "-c", code, str(HELPER)],
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {
            "network": True, "write": True, "credential": True,
            "db_write": True, "wrong_db": True, "subprocess": True, "read": True, "connections": 1,
        })


if __name__ == "__main__":
    unittest.main()
