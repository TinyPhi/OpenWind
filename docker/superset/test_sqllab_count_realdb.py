"""SQL Lab, a chart and the database must report the same count (#716, T4).

SQL Lab runs a query with `flask.g.user` set and flask_login's `current_user`
unauthenticated; a chart runs in an ordinary request where `current_user` is the
logged-in user. Before #716 the first state stamped no tenant and SQL Lab counted
zero. This builds each connection through the real DB_CONNECTION_MUTATOR, runs
`SELECT count(*)` against a real platform database as the reporting role, and
compares both with a count taken straight from the table.

Needs a migrated platform database with at least two tenants and an own-rows
subject who owns fewer tickets than their tenant holds, so it skips unless:
    REPORTING_TEST_DATABASE_URL        the reporting role (analytics_user)
    REPORTING_TEST_ADMIN_DATABASE_URL  a role that can read every tenant's rows
    REPORTING_BINDING_SECRET           the secret in that database's reporting_binding_key
Runs in the Superset image, on the database's network.
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
REAL = ("REPORTING_TEST_DATABASE_URL", "REPORTING_TEST_ADMIN_DATABASE_URL",
        "REPORTING_BINDING_SECRET")
COUNT = "SELECT count(*) FROM reporting_instances"
# Read now, at import: other test modules overwrite this variable while they run,
# and the config signs with whatever is set when it is imported.
BINDING_SECRET = os.environ.get("REPORTING_BINDING_SECRET", "")


class Role:
    def __init__(self, name):
        self.name = name


class User:
    is_authenticated = True

    def __init__(self, username, roles):
        self.username = username
        self.roles = [Role(r) for r in roles]


class Unauthenticated:
    is_authenticated = False
    roles = []


@unittest.skipUnless(
    importlib.util.find_spec("flask") is not None and all(os.environ.get(k) for k in REAL),
    "needs the Superset image and a real platform database (see module docstring)",
)
class SqlLabChartDatabaseCounts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._saved = {k: os.environ.get(k) for k in (
            "SUPERSET_SECRET_KEY", "SUPERSET_GUEST_TOKEN_SECRET", "DATABASE_URL", "REDIS_URL",
            "REPORTING_BINDING_SECRET")}
        os.environ.update({
            "REPORTING_BINDING_SECRET": BINDING_SECRET,
            "SUPERSET_SECRET_KEY": "x",
            "SUPERSET_GUEST_TOKEN_SECRET": "y",
            "DATABASE_URL": "postgresql://u:p@localhost/db",
            "REDIS_URL": "redis://localhost:6379/0",
        })
        for name in ("superset_config", "superset.config"):
            sys.modules.pop(name, None)
        stub = types.ModuleType("superset.config")
        stub.TALISMAN_CONFIG = {
            "content_security_policy": {"frame-ancestors": ["'self'"]},
            "frame_options": "SAMEORIGIN",
        }
        sys.modules["superset.config"] = stub
        sys.path.insert(0, str(HERE))
        try:
            cls.config = importlib.import_module("superset_config")
        finally:
            sys.path.remove(str(HERE))
        from flask import Flask
        from sqlalchemy import create_engine, text

        cls.app = Flask(__name__)
        cls.admin = create_engine(os.environ["REPORTING_TEST_ADMIN_DATABASE_URL"])
        with cls.admin.connect() as conn:
            tenants = conn.execute(text(
                "SELECT tenant_id::text, count(*) FROM reporting_instances "
                "GROUP BY 1 ORDER BY 2 DESC")).fetchall()
            cls.skip_reason = None
            if len(tenants) < 2:
                cls.skip_reason = "needs two tenants with tickets"
                return
            cls.tenant, cls.tenant_total = tenants[0][0], tenants[0][1]
            cls.other_tenant, cls.other_total = tenants[1][0], tenants[1][1]
            # The own-rows subject: whoever owns the most of the first tenant's
            # tickets while still owning fewer than all of them.
            owners = conn.execute(text(
                "SELECT created_by, count(*) FROM reporting_instances "
                "WHERE tenant_id = :t AND created_by ~ '^[0-9]+$' "
                "GROUP BY 1 ORDER BY 2 DESC"), {"t": cls.tenant}).fetchall()
            cls.subject = None
            for subject, _ in owners:
                own = conn.execute(text(
                    "SELECT count(*) FROM reporting_instances WHERE tenant_id = :t "
                    "AND (assigned_to = :s OR created_by = :s)"),
                    {"t": cls.tenant, "s": subject}).scalar()
                if 0 < own < cls.tenant_total:
                    cls.subject, cls.own_total = subject, own
                    break
            if cls.subject is None:
                cls.skip_reason = "needs an own-rows subject who owns some, not all, tickets"

    @classmethod
    def tearDownClass(cls):
        cls.admin.dispose()
        sys.modules.pop("superset_config", None)
        for k, v in cls._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def setUp(self):
        if self.skip_reason:
            self.skipTest(self.skip_reason)

    def count_as(self, user, state):
        """`count(*)` through a connection stamped by the real mutator, with the
        request in the SQL Lab state or the ordinary (chart) state."""
        from flask import g
        from sqlalchemy import create_engine, text
        from sqlalchemy.pool import NullPool

        sql_lab = state == "sql_lab"
        with self.app.test_request_context("/"), mock.patch(
            "flask_login.current_user", Unauthenticated() if sql_lab else user
        ):
            if sql_lab:
                g.user = user
            else:
                g.pop("user", None)
            _, params = self.config.DB_CONNECTION_MUTATOR(None, {}, user.username, object(), None)
        engine = create_engine(
            os.environ["REPORTING_TEST_DATABASE_URL"],
            poolclass=NullPool,
            connect_args=params.get("connect_args", {}),
        )
        try:
            with engine.connect() as conn:
                return conn.execute(text(COUNT)).scalar()
        finally:
            engine.dispose()

    def assert_counts(self, user, expected):
        sql_lab = self.count_as(user, "sql_lab")
        chart = self.count_as(user, "chart")
        self.assertEqual((sql_lab, chart), (expected, expected))

    def test_staff_counts_match_the_database(self):
        staff = User("staff", ["ReportingStaff", f"tenant:{self.tenant}"])
        self.assert_counts(staff, self.tenant_total)

    def test_own_rows_analyst_counts_match_the_database(self):
        analyst = User("analyst", [
            "ReportingAnalyst", f"tenant:{self.tenant}", f"owuser:{self.subject}"])
        self.assert_counts(analyst, self.own_total)
        self.assertLess(self.own_total, self.tenant_total)

    def test_second_tenant_counts_match_the_database_and_exclude_the_first(self):
        staff = User("other", ["ReportingStaff", f"tenant:{self.other_tenant}"])
        self.assert_counts(staff, self.other_total)


if __name__ == "__main__":
    unittest.main()
