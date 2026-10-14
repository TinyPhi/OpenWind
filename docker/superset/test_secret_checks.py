"""Tests for the secret checks at the top of superset_config.py (ADR-023).

Stdlib only, same harness as test_nullpool_guard.py:

    python -m unittest docker/superset/test_secret_checks.py
"""

import os
import unittest

from test_nullpool_guard import ENV, GOOD_CORE, load_config, make_tree

REAL = "r" * 40  # long enough for production, not a dev default


class SecretChecks(unittest.TestCase):
    def setUp(self):
        keys = set(ENV) | {"NODE_ENV"}
        self._saved = {k: os.environ.get(k) for k in keys}
        os.environ.update(ENV)
        os.environ.pop("NODE_ENV", None)

    def tearDown(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def load(self):
        return load_config(make_tree(self, GOOD_CORE))

    def test_short_dev_values_still_start_outside_production(self):
        cfg = self.load()
        self.assertEqual(cfg.SECRET_KEY, ENV["SUPERSET_SECRET_KEY"])

    def test_refuses_an_empty_secret(self):
        for name in ("SUPERSET_SECRET_KEY", "SUPERSET_GUEST_TOKEN_SECRET", "REPORTING_BINDING_SECRET"):
            with self.subTest(name=name):
                os.environ[name] = "  "
                with self.assertRaisesRegex(RuntimeError, f"{name} is empty"):
                    self.load()
                os.environ[name] = ENV[name]

    def test_refuses_a_missing_secret(self):
        os.environ.pop("SUPERSET_SECRET_KEY")
        with self.assertRaises(KeyError):
            self.load()

    def test_production_refuses_dev_defaults_and_short_keys(self):
        os.environ["NODE_ENV"] = "production"
        for name in ("SUPERSET_SECRET_KEY", "SUPERSET_GUEST_TOKEN_SECRET", "REPORTING_BINDING_SECRET"):
            os.environ[name] = REAL
        cfg = self.load()
        self.assertEqual(cfg.SECRET_KEY, REAL)

        dev = {
            "SUPERSET_SECRET_KEY": "superset_dev_secret_key_change_in_prod",
            "SUPERSET_GUEST_TOKEN_SECRET": "superset_guest_dev_secret_key",
            "REPORTING_BINDING_SECRET": "reporting_binding_dev_secret_change_me_0001",
        }
        for name, value in dev.items():
            with self.subTest(name=name, case="dev default"):
                os.environ[name] = value
                with self.assertRaisesRegex(RuntimeError, "development default"):
                    self.load()
                os.environ[name] = REAL
            with self.subTest(name=name, case="short"):
                os.environ[name] = "short-but-not-empty"
                with self.assertRaisesRegex(RuntimeError, "at least 32 characters"):
                    self.load()
                os.environ[name] = REAL


    def test_production_refuses_dev_default_passwords_when_present(self):
        os.environ["NODE_ENV"] = "production"
        for name in ("SUPERSET_SECRET_KEY", "SUPERSET_GUEST_TOKEN_SECRET", "REPORTING_BINDING_SECRET"):
            os.environ[name] = REAL
        for name, dev in (
            ("SUPERSET_ADMIN_PASSWORD", "admin_dev_password"),
            ("SUPERSET_SERVICE_ACCOUNT_PASSWORD", "service_account_dev_password"),
        ):
            saved = os.environ.get(name)
            try:
                with self.subTest(name=name, case="dev default"):
                    os.environ[name] = dev
                    with self.assertRaisesRegex(RuntimeError, f"{name} is its development default"):
                        self.load()
                with self.subTest(name=name, case="real value"):
                    os.environ[name] = "a-real-password"
                    self.load()
                with self.subTest(name=name, case="absent (superset server)"):
                    os.environ.pop(name, None)
                    self.load()
            finally:
                if saved is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = saved

if __name__ == "__main__":
    unittest.main()
