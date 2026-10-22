"""Who may call the erasure endpoints (#728, spec T17, R8).

Only an active caller holding ReportingServiceAccount, matched by role and never
by username. No token is 401; Admin, an analyst or an inactive account is
refused. The erase itself is stubbed here (see test_erasure_realdb). CSRF is
Superset's app-wide protection and was checked over real HTTP (400 without it).

Needs Flask, so it runs inside the Superset image:
    python -m unittest test_erasure_endpoint
"""

import importlib
import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
TENANT = "bbbbbbbb-0002-4000-b000-000000000002"


class Role:
    def __init__(self, name):
        self.name = name


class User:
    def __init__(self, roles, active=True, username="service_account"):
        self.roles = [Role(r) for r in roles]
        self.is_active = active
        self.username = username


@unittest.skipUnless(importlib.util.find_spec("flask") is not None, "needs Flask (runs in the image)")
class ErasureEndpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        keys = ("SUPERSET_SECRET_KEY", "SUPERSET_GUEST_TOKEN_SECRET", "DATABASE_URL",
                "REDIS_URL", "REPORTING_BINDING_SECRET")
        cls._saved = {k: os.environ.get(k) for k in keys}
        os.environ.update({
            "REPORTING_BINDING_SECRET": "z" * 32,
            "SUPERSET_SECRET_KEY": "x",
            "SUPERSET_GUEST_TOKEN_SECRET": "y",
            "DATABASE_URL": "postgresql://u:p@localhost/db",
            "REDIS_URL": "redis://localhost:6379/0",
        })
        importlib.import_module("superset.config")
        sys.modules.pop("superset_config", None)
        sys.path.insert(0, str(HERE))
        try:
            cls.config = importlib.import_module("superset_config")
        finally:
            sys.path.remove(str(HERE))
        from flask import Flask

        cls.app = Flask(__name__)
        cls.app.register_blueprint(cls.config._erasure_blueprint())

    @classmethod
    def tearDownClass(cls):
        sys.modules.pop("superset_config", None)
        for k, v in cls._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def call(self, path, caller, body=None, erase_result=None, no_token=False):
        """POST as `caller`; returns (status, json, erase mock, flush mock)."""
        verify = mock.Mock(side_effect=RuntimeError("no token") if no_token else None)
        erase = mock.Mock(return_value=erase_result or {"matchedUsers": 1, "deletedRows": 9, "more": False})
        flush = mock.Mock(return_value=4)
        with mock.patch("flask_jwt_extended.verify_jwt_in_request", verify), \
                mock.patch("flask_jwt_extended.current_user", caller), \
                mock.patch("superset.db", mock.MagicMock()), \
                mock.patch.object(self.config, "erase_superset_data", erase), \
                mock.patch.object(self.config, "flush_superset_cache", flush):
            res = self.app.test_client().post(path, json=body if body is not None else {})
        return res.status_code, json.loads(res.data), erase, flush

    SERVICE = User(["ReportingServiceAccount"])

    def test_no_token_is_401_and_erases_nothing(self):
        status, _, erase, flush = self.call("/openwind/erasure/user", None, no_token=True)
        self.assertEqual(status, 401)
        erase.assert_not_called()
        flush.assert_not_called()

    def test_admin_is_refused(self):
        status, _, erase, _ = self.call(
            "/openwind/erasure/user", User(["Admin"], username="admin"), {"tenantId": TENANT, "subject": "1"})
        self.assertEqual(status, 403)
        erase.assert_not_called()

    def test_an_analyst_is_refused(self):
        status, _, erase, _ = self.call(
            "/openwind/erasure/tenant", User(["ReportingAnalyst", f"tenant:{TENANT}"]), {"tenantId": TENANT})
        self.assertEqual(status, 403)
        erase.assert_not_called()

    def test_the_service_account_name_alone_is_not_enough(self):
        status, _, erase, _ = self.call(
            "/openwind/erasure/user", User(["ReportingAnalyst"], username="service_account"),
            {"tenantId": TENANT, "subject": "1"})
        self.assertEqual(status, 403)
        erase.assert_not_called()

    def test_an_inactive_service_account_is_refused(self):
        status, _, erase, _ = self.call(
            "/openwind/erasure/user", User(["ReportingServiceAccount"], active=False),
            {"tenantId": TENANT, "subject": "1"})
        self.assertEqual(status, 401)
        erase.assert_not_called()

    def test_the_service_account_erases_a_user_and_gets_counts_only(self):
        status, body, erase, flush = self.call(
            "/openwind/erasure/user", self.SERVICE, {"tenantId": TENANT, "subject": "393014046795759618"})
        self.assertEqual(status, 200)
        self.assertEqual(body, {"matchedUsers": 1, "deletedRows": 9, "more": False, "cacheKeysRemoved": 4})
        self.assertEqual(erase.call_args.args[1:], (TENANT, "393014046795759618"))
        flush.assert_called_once()

    def test_a_tenant_erase_passes_no_subject(self):
        status, _, erase, _ = self.call("/openwind/erasure/tenant", self.SERVICE, {"tenantId": TENANT})
        self.assertEqual(status, 200)
        self.assertEqual(erase.call_args.args[1:], (TENANT, None))

    def test_a_user_erase_without_a_subject_is_400(self):
        status, _, erase, _ = self.call("/openwind/erasure/user", self.SERVICE, {"tenantId": TENANT})
        self.assertEqual(status, 400)
        erase.assert_not_called()

    def test_a_subject_that_is_not_a_string_is_400(self):
        status, _, erase, _ = self.call(
            "/openwind/erasure/user", self.SERVICE, {"tenantId": TENANT, "subject": ["1", "2"]})
        self.assertEqual(status, 400)
        erase.assert_not_called()

    def test_a_bad_id_is_400(self):
        verify = mock.Mock()
        with mock.patch("flask_jwt_extended.verify_jwt_in_request", verify), \
                mock.patch("flask_jwt_extended.current_user", self.SERVICE), \
                mock.patch("superset.db", mock.MagicMock()):
            res = self.app.test_client().post("/openwind/erasure/user", json={"tenantId": "x", "subject": "1"})
        self.assertEqual(res.status_code, 400)

    def test_no_flush_until_the_erase_is_finished(self):
        _, body, _, flush = self.call(
            "/openwind/erasure/user", self.SERVICE, {"tenantId": TENANT, "subject": "1"},
            erase_result={"matchedUsers": 1, "deletedRows": 5000, "more": True})
        self.assertTrue(body["more"])
        self.assertEqual(body["cacheKeysRemoved"], 0)
        flush.assert_not_called()

    def test_no_flush_when_nobody_matched(self):
        _, body, _, flush = self.call(
            "/openwind/erasure/user", self.SERVICE, {"tenantId": TENANT, "subject": "1"},
            erase_result={"matchedUsers": 0, "deletedRows": 0, "more": False})
        self.assertEqual(body["cacheKeysRemoved"], 0)
        flush.assert_not_called()

    def test_the_cache_endpoint_is_service_account_only(self):
        status, _, _, flush = self.call("/openwind/erasure/cache", User(["Admin"], username="admin"))
        self.assertEqual(status, 403)
        flush.assert_not_called()
        status, body, _, flush = self.call("/openwind/erasure/cache", self.SERVICE)
        self.assertEqual((status, body), (200, {"cacheKeysRemoved": 4}))


if __name__ == "__main__":
    unittest.main()
