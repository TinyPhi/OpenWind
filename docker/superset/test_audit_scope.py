"""What an audit row may contain, and whose query it may quote (#709).

Two defects found in review of the audit writer, each pinned here:

1. A chart export has no SQL the request carries, so its row said nothing about
   what was exported. It now records the chart, the dataset and the format.
2. An SQL Lab export looked up the query text by `client_id` alone. `client_id`
   is supplied by the caller and Superset's export checks access to the
   database, not who owns the query, so a forged id naming another tenant's
   query copied that tenant's SQL into the caller's audit row. Reproduced on a
   live Superset before the fix; the lookup is now scoped to the caller's own
   queries.

The lookup also runs on its own connection under a 2 s limit, so a slow
metadata database withholds the SQL instead of holding the request (#813).

Needs Flask, so it runs inside the Superset image (the CI job in the plan):
    python -m unittest test_audit_scope
"""

import contextlib
import importlib
import importlib.util
import json
import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent

SECRET = "SELECT 'TENANT-A-SECRET' FROM reporting_instances"
USER_A, USER_B = 1, 2


class Role:
    def __init__(self, name):
        self.name = name


class User:
    def __init__(self, uid, roles=()):
        self.id = uid
        self.username = f"user-{uid}"
        self.roles = [Role(r) for r in roles]


class FakeQuery:
    def __init__(self, client_id, user_id, sql):
        self.client_id, self.user_id, self.sql = client_id, user_id, sql


class FakeResult:
    def __init__(self, row):
        self._row = row

    def first(self):
        return self._row


class FakeEngine:
    """`engine.connect()` over an in-memory list of queries.

    Records every statement in order, and the parameters of each lookup in
    `filters`. `fail` makes the lookup raise, as a statement timeout does.
    """

    def __init__(self, rows, dialect="postgresql", fail=None):
        self.rows, self.fail = rows, fail
        self.statements, self.filters = [], []
        self.dialect = types.SimpleNamespace(name=dialect)

    @contextlib.contextmanager
    def connect(self):
        yield self

    @contextlib.contextmanager
    def begin(self):
        yield self

    def execute(self, statement, params=None):
        self.statements.append(str(statement))
        if params is None:
            return FakeResult(None)
        self.filters.append(params)
        if self.fail:
            raise self.fail
        matches = [r for r in self.rows
                   if r.client_id == params["client_id"] and r.user_id == params["user_id"]]
        return FakeResult(matches[0] if matches else None)


@unittest.skipUnless(importlib.util.find_spec("flask") is not None, "needs Flask (runs in the image)")
class AuditScope(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        keys = ("SUPERSET_SECRET_KEY", "SUPERSET_GUEST_TOKEN_SECRET", "DATABASE_URL",
                "REDIS_URL", "SUPERSET_OAUTH_CLIENT_ID", "REPORTING_BINDING_SECRET")
        cls._saved = {k: os.environ.get(k) for k in keys}
        os.environ.update({
            "REPORTING_BINDING_SECRET": "z" * 32,
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

        cls.app = Flask(__name__)
        cls.logger = cls.config.EVENT_LOGGER

    @classmethod
    def tearDownClass(cls):
        sys.modules.pop("superset_config", None)
        for k, v in cls._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def payload(self, rows, action, record, user, kwargs=None, **engine):
        """The payload, plus the fake engine the lookup ran on."""
        lookup = FakeEngine(rows, **engine)
        fake_db = mock.MagicMock()
        fake_db.engine = lookup
        self.fake_db = fake_db
        with mock.patch("superset.db", fake_db):
            return self.logger.build_audit_payload(action, record, kwargs or {}, user), lookup

    # ── defect 2: another tenant's query text ─────────────────────────────────
    def test_a_forged_client_id_does_not_copy_another_users_sql(self):
        rows = [FakeQuery("tenantAqry01", USER_A, SECRET)]
        payload, _ = self.payload(rows, "reporting.exported", {"client_id": "tenantAqry01"}, User(USER_B))
        self.assertEqual(payload["sql"], "")
        self.assertTrue(payload["sql_withheld"])
        self.assertNotIn("TENANT-A-SECRET", json.dumps(payload))

    def test_the_owner_still_gets_their_own_sql_recorded(self):
        rows = [FakeQuery("tenantAqry01", USER_A, SECRET)]
        payload, _ = self.payload(rows, "reporting.exported", {"client_id": "tenantAqry01"}, User(USER_A))
        self.assertEqual(payload["sql"], SECRET)
        self.assertNotIn("sql_withheld", payload)

    def test_the_lookup_is_filtered_by_the_callers_id(self):
        rows = [FakeQuery("q1", USER_A, SECRET)]
        _, lookup = self.payload(rows, "reporting.exported", {"client_id": "q1"}, User(USER_B))
        self.assertEqual(lookup.filters, [{"client_id": "q1", "user_id": USER_B}])

    def test_no_caller_id_means_nothing_is_looked_up_or_recorded(self):
        rows = [FakeQuery("q1", USER_A, SECRET)]
        payload, lookup = self.payload(rows, "reporting.exported", {"client_id": "q1"}, User(None))
        self.assertEqual(lookup.filters, [])
        self.assertEqual(payload["sql"], "")
        self.assertTrue(payload["sql_withheld"])

    # ── #813: the lookup cannot hold the request ──────────────────────────────
    def test_the_lookup_runs_under_a_time_limit(self):
        rows = [FakeQuery("q1", USER_B, "SELECT 1")]
        _, lookup = self.payload(rows, "reporting.exported", {"client_id": "q1"}, User(USER_B))
        self.assertIn("SET LOCAL statement_timeout = '2s'", lookup.statements[0])
        self.assertIn("FROM query", lookup.statements[1])

    def test_a_timed_out_lookup_withholds_the_sql_and_does_not_raise(self):
        rows = [FakeQuery("q1", USER_B, "SELECT 1")]
        timeout = RuntimeError("canceling statement due to statement timeout")
        payload, _ = self.payload(rows, "reporting.exported", {"client_id": "q1"}, User(USER_B), fail=timeout)
        self.assertEqual(payload["sql"], "")
        self.assertTrue(payload["sql_withheld"])

    def test_the_lookup_does_not_touch_superset_s_request_session(self):
        rows = [FakeQuery("q1", USER_B, "SELECT 1")]
        self.payload(rows, "reporting.exported", {"client_id": "q1"}, User(USER_B))
        self.assertEqual(self.fake_db.session.method_calls, [])

    def test_no_postgres_time_limit_is_sent_to_another_database(self):
        rows = [FakeQuery("q1", USER_B, "SELECT 1")]
        payload, lookup = self.payload(rows, "reporting.exported", {"client_id": "q1"}, User(USER_B),
                                       dialect="sqlite")
        self.assertEqual(payload["sql"], "SELECT 1")
        self.assertFalse(any("statement_timeout" in s for s in lookup.statements))

    def test_an_unknown_client_id_is_withheld_not_an_error(self):
        payload, _ = self.payload([], "reporting.exported", {"client_id": "nope"}, User(USER_B))
        self.assertEqual(payload["sql"], "")
        self.assertTrue(payload["sql_withheld"])

    def test_sql_the_caller_just_ran_is_taken_from_the_request_without_a_lookup(self):
        rows = [FakeQuery("q1", USER_A, SECRET)]
        payload, lookup = self.payload(
            rows, "reporting.query_executed", {"client_id": "q1", "sql": "SELECT 1"}, User(USER_B))
        self.assertEqual(payload["sql"], "SELECT 1")
        self.assertEqual(lookup.filters, [])

    # ── #812: the audit row names the database, not only its id ───────────────
    def appended_row(self, database_id, reporting_db_id=2):
        """The metadata `_append_platform_audit` writes, with the database stubbed."""
        written = []

        class Conn:
            def execute(self_inner, _statement, params):
                written.append(json.loads(params["meta"]))

        class FakeDatabase:
            id, database_name = reporting_db_id, "OpenWind Platform"

            @contextlib.contextmanager
            def get_sqla_engine(self_inner):
                yield types.SimpleNamespace(begin=lambda: contextlib.nullcontext(Conn()))

        fake_db = mock.MagicMock()
        fake_db.session.query.return_value.filter_by.return_value.one_or_none.return_value = FakeDatabase()
        models = types.ModuleType("superset.models")
        core = types.ModuleType("superset.models.core")
        core.Database = type("Database", (), {})
        models.core = core
        record = {"path": "/api/v1/sqllab/execute/", "client_id": "q1", "sql": "SELECT 1",
                  "database_id": database_id}
        with mock.patch("superset.db", fake_db), \
                mock.patch.dict(sys.modules, {"superset.models": models, "superset.models.core": core}), \
                mock.patch.object(self.config, "_tenant_from_user_roles", return_value="t"), \
                mock.patch.object(self.config, "_session_user", return_value=User(USER_B)), \
                mock.patch.object(self.config, "audit_actor", return_value="a"):
            self.logger._append_platform_audit("reporting.query_executed", record, {})
        return written[0]

    def test_the_row_names_the_reporting_database(self):
        row = self.appended_row(database_id=2)
        self.assertEqual(row["database_id"], 2)
        self.assertEqual(row["database_name"], "OpenWind Platform")

    def test_a_different_database_id_gets_no_guessed_name(self):
        row = self.appended_row(database_id=5)
        self.assertEqual(row["database_id"], 5)
        self.assertNotIn("database_name", row)

    def test_no_database_id_gets_no_name(self):
        self.assertNotIn("database_name", self.appended_row(database_id=None))

    # ── defect 1: a chart export says what was exported ───────────────────────
    def test_a_chart_export_records_the_chart_dataset_and_format(self):
        record = {"path": "/api/v1/chart/data", "result_format": "csv",
                  "form_data": {"slice_id": 8, "datasource": "8__table"}}
        payload, _ = self.payload([], "reporting.exported", record, User(USER_B), {"slice_id": 0})
        self.assertEqual(payload["export"], {"kind": "chart", "format": "csv", "slice_id": 8, "datasource": "8__table"})
        self.assertEqual(payload["sql"], "")
        self.assertNotIn("sql_withheld", payload)

    def test_a_get_chart_export_takes_the_chart_id_from_the_path(self):
        # The live GET carries only `format`; `result_format` is for the POST shapes.
        record = {"path": "/api/v1/chart/2/data/", "format": "csv"}
        payload, _ = self.payload([], "reporting.exported", record, User(USER_B))
        self.assertEqual(payload["export"]["slice_id"], 2)
        self.assertEqual(payload["export"]["format"], "csv")

    def test_a_json_post_takes_the_dataset_from_the_body(self):
        record = {"path": "/api/v1/chart/data", "result_format": "xlsx", "datasource": {"id": 8, "type": "table"}}
        payload, _ = self.payload([], "reporting.exported", record, User(USER_B))
        self.assertEqual(payload["export"]["datasource"], "8__table")
        self.assertEqual(payload["export"]["format"], "xlsx")

    def test_nothing_a_caller_types_reaches_the_audit_row_through_the_chart_detail(self):
        record = {"path": "/api/v1/chart/data", "result_format": "csv" + "x" * 50,
                  "slice_id": "1; DROP TABLE admin_audit_log", "datasource": "8__table'; --"}
        detail = self.config.chart_export_detail(record, 0, record["result_format"])
        self.assertIsNone(detail["slice_id"])
        self.assertIsNone(detail["datasource"])
        # Not csv/xlsx, so it is labelled unknown and clipped, never recorded as a clean value.
        self.assertTrue(detail["format"].startswith("unknown:"))
        self.assertLessEqual(len(detail["format"]), len("unknown:") + 10)

    def test_an_sql_lab_export_is_not_labelled_a_chart_export(self):
        rows = [FakeQuery("q1", USER_B, "SELECT 1")]
        payload, _ = self.payload(rows, "reporting.exported", {"client_id": "q1"}, User(USER_B))
        self.assertNotIn("export", payload)

    # ── the real button: Superset's log record drops the chart and dataset ─────
    # Recorded from a live Superset 6.1.0: the "Export to .CSV" form post is logged
    # with only the first query's parameters under `form_data` (no `slice_id`, no
    # `datasource`), so those must come from the posted body.
    REAL_BUTTON_RECORD = {
        "path": "/api/v1/chart/data",
        "form_data": {"columns": ["state"], "metrics": ["count"], "row_limit": 50},
        "csrf_token": "redacted",
        "object_ref": "ChartDataRestApi.data",
        "is_cached": [None],
    }

    def posted_query_context(self, **over):
        body = {
            "datasource": {"id": 8, "type": "table"},
            "force": False,
            "queries": [{"columns": ["state"], "metrics": ["count"]}],
            "form_data": {"slice_id": 36, "columns": ["state"]},
            "result_format": "csv",
            "result_type": "full",
        }
        body.update(over)
        return body

    def test_the_real_button_records_the_chart_and_dataset_from_the_posted_form(self):
        ctx = self.app.test_request_context(
            "/api/v1/chart/data", method="POST",
            data={"form_data": json.dumps(self.posted_query_context())})
        with ctx:
            payload, _ = self.payload([], "reporting.exported", dict(self.REAL_BUTTON_RECORD), User(USER_B))
        self.assertEqual(payload["export"], {"kind": "chart", "format": "csv", "slice_id": 36, "datasource": "8__table"})

    def test_a_json_post_records_the_chart_and_dataset_from_the_body(self):
        ctx = self.app.test_request_context(
            "/api/v1/chart/data", method="POST", json=self.posted_query_context(result_format="xlsx"))
        with ctx:
            record = {**self.REAL_BUTTON_RECORD, "result_format": "xlsx"}
            payload, _ = self.payload([], "reporting.exported", record, User(USER_B))
        self.assertEqual(payload["export"]["slice_id"], 36)
        self.assertEqual(payload["export"]["datasource"], "8__table")
        self.assertEqual(payload["export"]["format"], "xlsx")

    def test_the_posted_body_cannot_smuggle_text_into_the_row(self):
        hostile = self.posted_query_context(
            datasource={"id": "8; DROP TABLE x", "type": "table'"},
            form_data={"slice_id": "36 OR 1=1"})
        ctx = self.app.test_request_context(
            "/api/v1/chart/data", method="POST", data={"form_data": json.dumps(hostile)})
        with ctx:
            detail = self.config.chart_export_detail(dict(self.REAL_BUTTON_RECORD), 0, "csv")
        self.assertIsNone(detail["slice_id"])
        self.assertIsNone(detail["datasource"])

    def test_the_export_format_is_allowlisted(self):
        label = self.config._export_format_label
        self.assertEqual(label("csv"), "csv")
        self.assertEqual(label("XLSX"), "xlsx")
        self.assertEqual(label("arrow"), "unknown:arrow")
        self.assertEqual(label(None), "unknown:")
        self.assertEqual(label("csv; DROP TABLE x"), "unknown:csv; drop ")

    def test_an_unsaved_chart_has_a_dataset_but_no_chart_id(self):
        ctx = self.app.test_request_context(
            "/api/v1/chart/data", method="POST",
            data={"form_data": json.dumps(self.posted_query_context(form_data={"columns": ["state"]}))})
        with ctx:
            detail = self.config.chart_export_detail(dict(self.REAL_BUTTON_RECORD), 0, "csv")
        self.assertIsNone(detail["slice_id"])
        self.assertEqual(detail["datasource"], "8__table")

    def test_a_malformed_form_post_does_not_break_the_audit(self):
        ctx = self.app.test_request_context(
            "/api/v1/chart/data", method="POST", data={"form_data": "{not json"})
        with ctx:
            self.assertEqual(self.config.posted_chart_body(), {})
            detail = self.config.chart_export_detail(dict(self.REAL_BUTTON_RECORD), 0, "csv")
        self.assertEqual(detail, {"kind": "chart", "format": "csv", "slice_id": None, "datasource": None})

    # ── finding 3: the request parse stays cheap ──────────────────────────────
    def test_the_form_post_is_parsed_once_per_request(self):
        body = json.dumps({"result_format": "csv"})
        with self.app.test_request_context("/api/v1/chart/data", method="POST", data={"form_data": body}):
            with mock.patch.object(self.config.json, "loads", wraps=json.loads) as loads:
                self.assertEqual(self.config.requested_result_format(), "csv")
                self.assertEqual(self.config.requested_result_format(), "csv")
                self.assertEqual(loads.call_count, 1)

    def test_a_plain_dashboard_load_parses_nothing(self):
        with self.app.test_request_context("/api/v1/chart/2/data/"):
            with mock.patch.object(self.config.json, "loads", wraps=json.loads) as loads:
                self.assertEqual(self.config.requested_result_format(), "")
                self.assertEqual(loads.call_count, 0)


if __name__ == "__main__":
    unittest.main()
