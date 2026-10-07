"""SQL Lab must be stamped with the user's tenant, like a chart is (#716).

While SQL Lab runs a query Superset sets `flask.g.user` (override_user) but
flask_login's `current_user` is unauthenticated. The tenant and own-rows lookups
used `current_user`, found nobody, stamped no tenant, and RLS returned zero rows.
These tests reproduce that state and pin both lookups to the same user.

Needs Flask, so it runs inside the Superset image (see the CI job):
    python -m unittest test_sqllab_identity
"""

import importlib
import importlib.util
import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
TENANT = "00000000-0000-0000-0000-000000000001"
OTHER_TENANT = "bbbbbbbb-0002-4000-b000-000000000002"

ENV = {
    "SUPERSET_SECRET_KEY": "x",
    "SUPERSET_GUEST_TOKEN_SECRET": "y",
    "REPORTING_BINDING_SECRET": "z" * 32,
    "DATABASE_URL": "postgresql://u:p@localhost/db",
    "REDIS_URL": "redis://localhost:6379/0",
}


class Role:
    def __init__(self, name):
        self.name = name


class User:
    def __init__(self, username, roles, authenticated=True):
        self.username = username
        self.roles = [Role(r) for r in roles]
        self.is_authenticated = authenticated


def load_config():
    for name in ("superset_config", "superset.config"):
        sys.modules.pop(name, None)
    if "superset.config" not in sys.modules:
        stub = types.ModuleType("superset.config")
        stub.TALISMAN_CONFIG = {
            "content_security_policy": {"frame-ancestors": ["'self'"]},
            "frame_options": "SAMEORIGIN",
        }
        sys.modules["superset.config"] = stub
    sys.path.insert(0, str(HERE))
    try:
        return importlib.import_module("superset_config")
    finally:
        sys.path.remove(str(HERE))


@unittest.skipUnless(importlib.util.find_spec("flask") is not None, "needs Flask (runs in the image)")
class SqlLabIdentity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._saved = {k: os.environ.get(k) for k in ENV}
        os.environ.update(ENV)
        cls.config = load_config()
        from flask import Flask

        cls.app = Flask(__name__)

    @classmethod
    def tearDownClass(cls):
        for k, v in cls._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def run_as(self, g_user, fn, path="/"):
        """Call `fn` the way SQL Lab does: a request, `g.user` set, and
        flask_login's current_user left unauthenticated."""
        from flask import g

        with self.app.test_request_context(path):
            g.user = g_user
            return fn()

    def test_tenant_is_found_when_only_g_user_is_set(self):
        analyst = User("ana", ["ReportingAnalyst", f"tenant:{TENANT}"])
        self.assertEqual(self.run_as(analyst, self.config._tenant_from_user_roles), TENANT)

    def test_own_rows_binding_is_found_the_same_way(self):
        # If the tenant resolved but this did not, a non-staff analyst would be
        # widened from their own tickets to the whole tenant.
        analyst = User("ana", [f"tenant:{TENANT}", "owuser:386221898641440771"])
        self.assertEqual(
            self.run_as(analyst, self.config._own_rows_subject), "386221898641440771"
        )

    def test_staff_without_binding_is_tenant_wide(self):
        staff = User("sam", ["ReportingStaff", f"tenant:{TENANT}"])
        self.assertIsNone(self.run_as(staff, self.config._own_rows_subject))
        self.assertEqual(self.run_as(staff, self.config._tenant_from_user_roles), TENANT)

    def test_unauthenticated_g_user_yields_nothing(self):
        ghost = User("ghost", [f"tenant:{TENANT}"], authenticated=False)
        self.assertIsNone(self.run_as(ghost, self.config._tenant_from_user_roles))
        self.assertIsNone(self.run_as(ghost, self.config._own_rows_subject))

    def test_ordinary_request_falls_back_to_current_user(self):
        # The chart and dashboard path: `g.user` is not set, flask_login's
        # `current_user` is the authenticated user (#807). Both lookups must use it.
        analyst = User("ana", ["ReportingAnalyst", f"tenant:{TENANT}", "owuser:386221898641440771"])
        with self.app.test_request_context("/"), mock.patch("flask_login.current_user", analyst):
            from flask import g

            self.assertIsNone(g.get("user"))
            self.assertEqual(self.config._tenant_from_user_roles(), TENANT)
            self.assertEqual(self.config._own_rows_subject(), "386221898641440771")

    def test_an_unexpected_error_is_logged_and_fails_closed(self):
        # #806: an error inside the resolver must not look like "no tenant role".
        # It still yields no user (fail closed), but leaves a warning with the trace.
        with self.app.test_request_context("/"), mock.patch(
            "flask.has_app_context", side_effect=RuntimeError("resolver broke")
        ):
            with self.assertLogs(self.config.logger, level="WARNING") as logs:
                self.assertIsNone(self.config._session_user())
                self.assertIsNone(self.config._tenant_from_user_roles())
        self.assertIn("failing closed", logs.output[0])
        self.assertIsNotNone(logs.records[0].exc_info)
        self.assertIn("resolver broke", str(logs.records[0].exc_info[1]))

    def test_no_user_yields_nothing(self):
        self.assertIsNone(self.run_as(None, self.config._tenant_from_user_roles))

    def test_no_app_context_yields_nothing(self):
        self.assertIsNone(self.config._tenant_from_user_roles())

    def test_two_tenant_roles_refuse_to_choose(self):
        broken = User("dup", [f"tenant:{TENANT}", f"tenant:{OTHER_TENANT}"])
        self.assertIsNone(self.run_as(broken, self.config._tenant_from_user_roles))

    def test_user_without_tenant_role_yields_nothing(self):
        self.assertIsNone(
            self.run_as(User("nobody", ["ReportingAnalyst"]), self.config._tenant_from_user_roles)
        )

    def test_connection_for_sql_lab_user_is_stamped_with_their_tenant(self):
        analyst = User("ana", ["ReportingAnalyst", f"tenant:{TENANT}"])

        def stamp():
            return self.config.DB_CONNECTION_MUTATOR(None, {}, "ana", object(), None)

        _, params = self.run_as(analyst, stamp)
        options = params["connect_args"]["options"]
        self.assertIn(f"app.tenant_id={TENANT}", options)
        self.assertIn("app.reporting_binding_sig=", options)
        self.assertNotIn("app.reporting_scope=own", options)

    def test_connection_for_own_rows_analyst_is_narrowed(self):
        analyst = User("ana", [f"tenant:{TENANT}", "owuser:386221898641440771"])

        def stamp():
            return self.config.DB_CONNECTION_MUTATOR(None, {}, "ana", object(), None)

        _, params = self.run_as(analyst, stamp)
        options = params["connect_args"]["options"]
        self.assertIn("app.reporting_scope=own", options)
        self.assertIn("app.reporting_user_id=386221898641440771", options)

    def test_connection_for_user_with_no_tenant_is_left_unstamped(self):
        def stamp():
            return self.config.DB_CONNECTION_MUTATOR(None, {}, "nobody", object(), None)

        _, params = self.run_as(User("nobody", ["ReportingAnalyst"]), stamp)
        self.assertNotIn("connect_args", params)


if __name__ == "__main__":
    unittest.main()
