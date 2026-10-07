"""The audit logger against a real platform database (#709, T3).

test_audit_mapping.py proves which events map to which action, with the write
mocked. This proves the write: Superset's event logger, the real connection
mutator (so the tenant binding is genuinely signed) and the real
`record_reporting_audit()` put exactly one row in `admin_audit_log` for a SQL Lab
query and for a chart CSV button post, and none for a JSON chart call.

It needs a migrated platform database, so it skips unless these are set:
    REPORTING_TEST_DATABASE_URL        the reporting role (analytics_user)
    REPORTING_TEST_ADMIN_DATABASE_URL  a role that can read and clean admin_audit_log
    REPORTING_BINDING_SECRET           the secret in that database's reporting_binding_key
    REPORTING_TEST_TENANT              an existing tenant id
Runs in the Superset image, on the database's network.
"""

import contextlib
import importlib
import importlib.util
import json
import os
import sys
import types
import unittest
import uuid
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent

REAL = ("REPORTING_TEST_DATABASE_URL", "REPORTING_TEST_ADMIN_DATABASE_URL",
        "REPORTING_BINDING_SECRET", "REPORTING_TEST_TENANT")
# Read now, at import: other test modules overwrite this variable while they run,
# and the config signs with whatever is set when it is imported.
BINDING_SECRET = os.environ.get("REPORTING_BINDING_SECRET", "")

SQLLAB_EXECUTE = (
    "SqlLabRestApi.get_results",
    {
        "path": "/api/v1/sqllab/execute/",
        "client_id": "t3realdb01",
        "database_id": 2,
        "schema": "public",
        "sql": "SELECT 1",
    },
)
CHART_BUTTON_RECORD = {"path": "/api/v1/chart/data", "object_ref": "ChartDataRestApi.data"}


class Role:
    def __init__(self, name):
        self.name = name


class User:
    is_authenticated = True

    def __init__(self, roles):
        self.username = "t3-user"
        self.roles = [Role(r) for r in roles]


@unittest.skipUnless(
    importlib.util.find_spec("flask") is not None and all(os.environ.get(k) for k in REAL),
    "needs the Superset image and a real platform database (see module docstring)",
)
class AuditAgainstRealDatabase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._saved = {k: os.environ.get(k) for k in (
            "SUPERSET_SECRET_KEY", "SUPERSET_GUEST_TOKEN_SECRET", "DATABASE_URL",
            "REDIS_URL", "SUPERSET_OAUTH_CLIENT_ID", "REPORTING_BINDING_SECRET")}
        os.environ.update({
            "REPORTING_BINDING_SECRET": BINDING_SECRET,
            "SUPERSET_SECRET_KEY": "x",
            "SUPERSET_GUEST_TOKEN_SECRET": "y",
            "DATABASE_URL": "postgresql://u:p@localhost/db",
            "REDIS_URL": "redis://localhost:6379/0",
            # The audit logger is part of the Stage 2 block.
            "SUPERSET_OAUTH_CLIENT_ID": "test-client",
        })
        importlib.import_module("superset.config")
        sys.modules.pop("superset_config", None)
        sys.path.insert(0, str(HERE))
        try:
            cls.config = importlib.import_module("superset_config")
        finally:
            sys.path.remove(str(HERE))
        from flask import Flask
        from sqlalchemy import create_engine

        cls.app = Flask(__name__)
        cls.tenant = os.environ["REPORTING_TEST_TENANT"]
        cls.admin = create_engine(os.environ["REPORTING_TEST_ADMIN_DATABASE_URL"])

    def setUp(self):
        # One actor per test, so the rows counted are this test's and nobody else's.
        self.subject = f"T3TEST{uuid.uuid4().hex[:12]}"

    def tearDown(self):
        # Only rows this test wrote, found by its own unique actor.
        with contextlib.suppress(Exception):
            from sqlalchemy import text

            with self.admin.begin() as conn:
                conn.execute(text("DELETE FROM admin_audit_log WHERE actor_id = :a"), {"a": self.subject})

    @classmethod
    def tearDownClass(cls):
        cls.admin.dispose()
        sys.modules.pop("superset_config", None)
        for k, v in cls._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def rows(self, action):
        from sqlalchemy import text

        with self.admin.connect() as conn:
            return conn.execute(
                text("SELECT tenant_id::text, actor_id FROM admin_audit_log "
                     "WHERE actor_id = :a AND action = :act"),
                {"a": self.subject, "act": action},
            ).fetchall()

    def fake_database(self):
        """A stand-in for Superset's Database row whose engine is built the way
        Superset builds it: through the real DB_CONNECTION_MUTATOR."""
        from sqlalchemy import create_engine
        from sqlalchemy.pool import NullPool

        config = self.config

        class FakeDatabase:
            @contextlib.contextmanager
            def get_sqla_engine(self_inner):
                _, params = config.DB_CONNECTION_MUTATOR(
                    None, {}, "t3-user", object(), None
                )
                engine = create_engine(
                    os.environ["REPORTING_TEST_DATABASE_URL"],
                    poolclass=NullPool,
                    connect_args=params.get("connect_args", {}),
                )
                try:
                    yield engine
                finally:
                    engine.dispose()

        return FakeDatabase()

    def drive(self, request_ctx, action, record, roles=None):
        """Run one Superset event through the real logger."""
        from flask import g

        user = User(roles if roles is not None else [
            "ReportingAnalyst", f"tenant:{self.tenant}", f"owsub:{self.subject}"])
        fake_db = mock.MagicMock()
        fake_db.session.query.return_value.filter_by.return_value.one_or_none.return_value = (
            self.fake_database()
        )
        # Superset's models need a full Flask app (babel) just to import; the
        # logger only uses `Database` as the argument of a query that is stubbed.
        models = types.ModuleType("superset.models")
        models_core = types.ModuleType("superset.models.core")
        models_core.Database = type("Database", (), {})
        models.core = models_core
        stubs = {"superset.models": models, "superset.models.core": models_core}
        with mock.patch("superset.utils.log.DBEventLogger.log"), mock.patch(
            "superset.db", fake_db
        ), mock.patch.dict(sys.modules, stubs), mock.patch(
            "flask_login.current_user", user
        ), request_ctx:
            g.user = user
            self.config.EVENT_LOGGER.log(7, action, records=[record])

    def form_post(self, result_format):
        payload = {"datasource": {"id": 8, "type": "table"}, "queries": [{}],
                   "result_format": result_format}
        return self.app.test_request_context(
            "/api/v1/chart/data", method="POST", data={"form_data": json.dumps(payload)}
        )

    def test_a_sql_lab_query_writes_exactly_one_query_row(self):
        self.drive(self.app.test_request_context("/api/v1/sqllab/execute/", method="POST"),
                   *SQLLAB_EXECUTE)
        rows = self.rows("reporting.query_executed")
        self.assertEqual(rows, [(self.tenant, self.subject)])

    def test_the_chart_csv_button_writes_exactly_one_export_row(self):
        self.drive(self.form_post("csv"), "ChartDataRestApi.data", CHART_BUTTON_RECORD)
        rows = self.rows("reporting.exported")
        self.assertEqual(rows, [(self.tenant, self.subject)])

    def test_a_json_chart_call_writes_nothing(self):
        self.drive(self.form_post("json"), "ChartDataRestApi.data", CHART_BUTTON_RECORD)
        self.assertEqual(self.rows("reporting.exported"), [])
        self.assertEqual(self.rows("reporting.query_executed"), [])

    def test_a_session_with_no_tenant_writes_nothing(self):
        self.drive(self.form_post("csv"), "ChartDataRestApi.data", CHART_BUTTON_RECORD,
                   roles=["ReportingAnalyst", f"owsub:{self.subject}"])
        self.assertEqual(self.rows("reporting.exported"), [])


if __name__ == "__main__":
    unittest.main()
