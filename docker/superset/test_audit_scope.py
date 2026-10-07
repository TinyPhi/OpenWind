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

Needs Flask, so it runs inside the Superset image (the CI job in the plan):
    python -m unittest test_audit_scope
"""

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


class FakeSession:
    """`session.query(Query).filter_by(...).first()` over an in-memory list."""

    def __init__(self, rows):
        self.rows = rows
        self.filters = []

    def query(self, _model):
        return self

    def filter_by(self, **kw):
        self.filters.append(kw)
        self._matches = [r for r in self.rows if all(getattr(r, k) == v for k, v in kw.items())]
        return self

    def first(self):
        return self._matches[0] if self._matches else None


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

    def stubs(self, rows):
        """Superset's models need a full app just to import; only `Query` is used."""
        session = FakeSession(rows)
        fake_db = mock.MagicMock()
        fake_db.session = session
        models = types.ModuleType("superset.models")
        sql_lab = types.ModuleType("superset.models.sql_lab")
        sql_lab.Query = FakeQuery
        models.sql_lab = sql_lab
        patches = (
            mock.patch("superset.db", fake_db),
            mock.patch.dict(sys.modules, {"superset.models": models, "superset.models.sql_lab": sql_lab}),
        )
        return session, patches

    def payload(self, rows, action, record, user, kwargs=None):
        session, patches = self.stubs(rows)
        with patches[0], patches[1]:
            return self.logger.build_audit_payload(action, record, kwargs or {}, user), session

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
        _, session = self.payload(rows, "reporting.exported", {"client_id": "q1"}, User(USER_B))
        self.assertEqual(session.filters, [{"client_id": "q1", "user_id": USER_B}])

    def test_no_caller_id_means_nothing_is_looked_up_or_recorded(self):
        rows = [FakeQuery("q1", USER_A, SECRET)]
        payload, session = self.payload(rows, "reporting.exported", {"client_id": "q1"}, User(None))
        self.assertEqual(session.filters, [])
        self.assertEqual(payload["sql"], "")
        self.assertTrue(payload["sql_withheld"])

    def test_an_unknown_client_id_is_withheld_not_an_error(self):
        payload, _ = self.payload([], "reporting.exported", {"client_id": "nope"}, User(USER_B))
        self.assertEqual(payload["sql"], "")
        self.assertTrue(payload["sql_withheld"])

    def test_sql_the_caller_just_ran_is_taken_from_the_request_without_a_lookup(self):
        rows = [FakeQuery("q1", USER_A, SECRET)]
        payload, session = self.payload(
            rows, "reporting.query_executed", {"client_id": "q1", "sql": "SELECT 1"}, User(USER_B))
        self.assertEqual(payload["sql"], "SELECT 1")
        self.assertEqual(session.filters, [])

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
        self.assertLessEqual(len(detail["format"]), 10)

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
