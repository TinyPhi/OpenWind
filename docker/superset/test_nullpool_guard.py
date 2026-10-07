"""Tests for the NullPool startup guard in superset_config.py (#729, ADR-019).

Stdlib only. Runs two ways:
  * anywhere, against small fake Superset trees (the unit cases below);
  * inside the built image, where the same import is also made against the real
    Superset source. Once a CI job runs this against the built image, that
    becomes the runtime gate; no such job exists yet (#729).

    python -m unittest docker/superset/test_nullpool_guard.py
"""

import importlib
import importlib.util
import shutil
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

GOOD_CORE = '''
class Database:
    def get_sqla_engine(self, catalog=None, schema=None, nullpool: bool = True, source=None):
        return self._get_sqla_engine(nullpool=nullpool)

    def _get_sqla_engine(
        self,
        catalog=None,
        schema=None,
        nullpool: bool = True,
        source=None,
    ):
        engine_kwargs = {}
        if nullpool:
            engine_kwargs["poolclass"] = NullPool
        return engine_kwargs

    def get_raw_connection(self, catalog=None, schema=None, nullpool: bool = True):
        return self.get_sqla_engine(nullpool=nullpool)
'''

ENV = {
    "SUPERSET_SECRET_KEY": "x",
    "SUPERSET_GUEST_TOKEN_SECRET": "y",
    "REPORTING_BINDING_SECRET": "z",
    "DATABASE_URL": "postgresql://u:p@localhost/db",
    "REDIS_URL": "redis://localhost:6379/0",
}


def make_tree(core: str, extra: dict | None = None) -> Path:
    root = Path(tempfile.mkdtemp()) / "superset"
    (root / "models").mkdir(parents=True)
    (root / "__init__.py").write_text("")
    (root / "models" / "core.py").write_text(core)
    for rel, text in (extra or {}).items():
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
    return root


def load_config(superset_root: Path | None):
    """Import superset_config fresh. `superset_root` is put on sys.path as the
    `superset` package; None leaves the real one (or none) in place."""
    # superset_config is the file under test: always force a fresh import so
    # its module-level assert_connections_not_pooled() reruns. The real
    # `superset` package (and its submodules) is left alone when there is no
    # fake tree to substitute: popping it here would evict it from
    # sys.modules while its already-imported submodules stay cached under
    # their own keys, leaving a later real-install test with a fresh
    # `superset` module object whose submodules aren't attached to it.
    sys.modules.pop("superset_config", None)
    stub = None
    if superset_root is not None:
        sys.modules.pop("superset", None)
        stub = types.ModuleType("superset.config")
        stub.TALISMAN_CONFIG = {
            "content_security_policy": {"frame-ancestors": ["'self'"]},
            "frame_options": "SAMEORIGIN",
        }
        sys.modules["superset.config"] = stub
    sys.path.insert(0, str(HERE))
    if superset_root is not None:
        sys.path.insert(0, str(superset_root.parent))
    try:
        return importlib.import_module("superset_config")
    finally:
        sys.path.remove(str(HERE))
        if superset_root is not None:
            sys.path.remove(str(superset_root.parent))
        sys.modules.pop("superset_config", None)
        if stub is not None:
            sys.modules.pop("superset", None)
            sys.modules.pop("superset.config", None)


class NullPoolGuard(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in ENV}
        os.environ.update(ENV)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_starts_when_nullpool_is_the_default(self):
        load_config(make_tree(GOOD_CORE))

    def test_refuses_when_entrypoint_default_flips_to_false(self):
        core = GOOD_CORE.replace(
            "def get_sqla_engine(self, catalog=None, schema=None, nullpool: bool = True",
            "def get_sqla_engine(self, catalog=None, schema=None, nullpool: bool = False",
        )
        with self.assertRaisesRegex(RuntimeError, r"get_sqla_engine\(\) no longer defaults"):
            load_config(make_tree(core))

    def test_refuses_when_raw_connection_default_flips(self):
        core = GOOD_CORE.replace(
            "def get_raw_connection(self, catalog=None, schema=None, nullpool: bool = True",
            "def get_raw_connection(self, catalog=None, schema=None, nullpool: bool = False",
        )
        with self.assertRaisesRegex(RuntimeError, r"get_raw_connection\(\) no longer defaults"):
            load_config(make_tree(core))

    def test_refuses_when_poolclass_is_no_longer_nullpool(self):
        core = GOOD_CORE.replace("NullPool", "QueuePool")
        with self.assertRaisesRegex(RuntimeError, "poolclass = NullPool"):
            load_config(make_tree(core))

    def test_refuses_when_something_opts_out_with_nullpool_false(self):
        tree = make_tree(
            GOOD_CORE,
            {"sql_lab.py": "def run(db):\n    return db.get_sqla_engine(nullpool=False)\n"},
        )
        with self.assertRaisesRegex(RuntimeError, r"sql_lab\.py opts out"):
            load_config(tree)

    def test_ignores_opt_out_in_tests_directory(self):
        tree = make_tree(
            GOOD_CORE,
            {"tests/test_x.py": "db.get_sqla_engine(nullpool=False)\n"},
        )
        load_config(tree)

    def test_refuses_when_core_source_is_missing(self):
        root = Path(tempfile.mkdtemp()) / "superset"
        (root / "models").mkdir(parents=True)
        (root / "__init__.py").write_text("")
        with self.assertRaisesRegex(RuntimeError, "cannot read"):
            load_config(root)


@unittest.skipUnless(
    importlib.util.find_spec("superset") is not None,
    "real Superset not installed (only present in the built image)",
)
class RealSuperset(unittest.TestCase):
    def test_installed_superset_holds_the_guarantee(self):
        saved = {k: os.environ.get(k) for k in ENV}
        os.environ.update(ENV)
        # Superset imports its own defaults before it imports this config.
        importlib.import_module("superset.config")
        try:
            load_config(None)
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


@unittest.skipUnless(
    importlib.util.find_spec("superset") is not None,
    "real Superset not installed (only present in the built image)",
)
class RealSupersetPatched(unittest.TestCase):
    """Negative proof: a copy of the real source, patched to pool, must be refused."""

    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in ENV}
        os.environ.update(ENV)
        importlib.import_module("superset.config")
        spec = importlib.util.find_spec("superset")
        real = Path(spec.submodule_search_locations[0])
        self.copy = Path(tempfile.mkdtemp()) / "superset"
        shutil.copytree(
            real,
            self.copy,
            ignore=shutil.ignore_patterns(
                "tests", "static", "translations", "migrations", "node_modules"
            ),
        )
        self.cfg = load_config(None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _patch_core(self, old, new):
        core = self.copy / "models" / "core.py"
        text = core.read_text(encoding="utf-8")
        self.assertIn(old, text, "Superset source changed; update this test's patch")
        core.write_text(text.replace(old, new, 1), encoding="utf-8")

    def test_unpatched_copy_is_accepted(self):
        self.cfg.assert_connections_not_pooled(str(self.copy))

    def test_refuses_when_poolclass_is_swapped(self):
        self._patch_core('engine_kwargs["poolclass"] = NullPool', 'engine_kwargs["poolclass"] = QueuePool')
        with self.assertRaisesRegex(RuntimeError, "poolclass = NullPool"):
            self.cfg.assert_connections_not_pooled(str(self.copy))

    def test_refuses_when_a_new_caller_opts_out(self):
        (self.copy / "utils" / "pooled.py").write_text(
            "def f(db):\n    return db.get_sqla_engine(nullpool=False)\n"
        )
        with self.assertRaisesRegex(RuntimeError, r"pooled\.py opts out"):
            self.cfg.assert_connections_not_pooled(str(self.copy))


if __name__ == "__main__":
    unittest.main()
