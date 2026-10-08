"""Pins the reporting audit mapping to the events Superset 6.1.0 really writes (#709).

The records below are copied from rows in Superset's own `logs` table, taken
from a running 6.1.0 instance, so a rename of an action or a request field fails
here rather than silently producing no audit row.

    python -m unittest docker/superset/test_audit_mapping.py
"""

import importlib
import importlib.util
import json
import os
import sys
import types
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

ENV = {
    "SUPERSET_SECRET_KEY": "x",
    "SUPERSET_GUEST_TOKEN_SECRET": "y",
    "REPORTING_BINDING_SECRET": "z",
    "DATABASE_URL": "postgresql://u:p@localhost/db",
    "REDIS_URL": "redis://localhost:6379/0",
}


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


# Recorded from a real SQL Lab run and a real SQL Lab CSV export.
SQLLAB_EXECUTE = (
    "SqlLabRestApi.get_results",
    {
        "path": "/api/v1/sqllab/execute/",
        "client_id": "csvprobe01",
        "database_id": 2,
        "runAsync": False,
        "schema": "public",
        "sql": "SELECT id, reporting_title FROM reporting_instances LIMIT 5",
        "object_ref": "SqlLabRestApi.execute_sql_query",
    },
)
SQLLAB_EXPORT = (
    "SqlLabRestApi.export_streaming_csv",
    {
        "path": "/api/v1/sqllab/export_streaming/",
        "client_id": "csvprobe01",
        "object_ref": "SqlLabRestApi.export_streaming_csv",
    },
)
# Chart CSV export. Two request styles carry the format in the record itself: a
# JSON body (result_format), or the URL (?format= on GET /chart/<id>/data/).
CHART_CSV_POST = (
    "ChartDataRestApi.data",
    {"path": "/api/v1/chart/data", "result_format": "csv", "result_type": "full"},
)
CHART_CSV_GET = (
    "ChartDataRestApi.data",
    {"path": "/api/v1/chart/5/data/", "format": "csv"},
)

# What Superset really logged for the chart "Export to .CSV" button (a form post),
# taken from its `logs` table: the query, but no result_format. The format is only
# in the request, which is why the logger has to read it from there.
CHART_CSV_BUTTON_RECORD = {
    "path": "/api/v1/chart/data",
    "csrf_token": "redacted",
    "is_cached": [None],
    "object_ref": "ChartDataRestApi.data",
    "form_data": {
        "columns": ["status"],
        "metrics": ["count"],
        "row_limit": 10000,
        "filters": [{"col": "created_at", "op": "TEMPORAL_RANGE", "val": "No filter"}],
    },
}

# Events that must NOT write an audit row.
CHART_JSON = (
    "ChartDataRestApi.data",
    {"path": "/api/v1/chart/data", "result_format": "json"},
)
CHART_QUERY = ("execute_sql", {"path": "/superset/explore_json/"})
SQLLAB_RESULTS_FETCH = (
    "SqlLabRestApi.get_results",
    {"path": "/api/v1/sqllab/results/", "key": "abc"},
)
SQLLAB_LIST = ("SqlLabRestApi.get", {"path": "/api/v1/sqllab/"})
VALIDATE = ("DatabaseRestApi.validate_sql", {"path": "/api/v1/database/2/validate_sql/"})


class AuditMapping(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._saved = {k: os.environ.get(k) for k in ENV}
        os.environ.update(ENV)
        cls.config = load_config()

    @classmethod
    def tearDownClass(cls):
        for k, v in cls._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def classify(self, event):
        return self.config.classify_audit_event(*event)

    def test_sql_lab_query_is_audited_as_a_query(self):
        self.assertEqual(self.classify(SQLLAB_EXECUTE), "reporting.query_executed")

    def test_sql_lab_csv_export_is_audited_as_an_export(self):
        self.assertEqual(self.classify(SQLLAB_EXPORT), "reporting.exported")

    def test_plain_sql_lab_csv_export_is_audited_too(self):
        event = ("SqlLabRestApi.export_csv", {"path": "/api/v1/sqllab/export/csvprobe01/"})
        self.assertEqual(self.classify(event), "reporting.exported")

    def test_chart_csv_export_is_audited_as_an_export_for_both_request_styles(self):
        self.assertEqual(self.classify(CHART_CSV_POST), "reporting.exported")
        self.assertEqual(self.classify(CHART_CSV_GET), "reporting.exported")

    def test_xlsx_export_is_audited(self):
        event = ("ChartDataRestApi.data", {"path": "/api/v1/chart/data", "result_format": "XLSX"})
        self.assertEqual(self.classify(event), "reporting.exported")

    def test_each_audited_event_maps_to_exactly_one_action(self):
        # One real event, one audit row: nothing may be classified twice.
        for event in (SQLLAB_EXECUTE, SQLLAB_EXPORT, CHART_CSV_POST, CHART_CSV_GET):
            self.assertIn(
                self.classify(event),
                ("reporting.query_executed", "reporting.exported"),
            )

    def test_events_that_are_not_queries_or_exports_are_skipped(self):
        for event in (
            CHART_JSON,
            CHART_QUERY,
            SQLLAB_RESULTS_FETCH,
            SQLLAB_LIST,
            VALIDATE,
        ):
            self.assertIsNone(self.classify(event), event)

    def test_pre_6_1_names_are_no_longer_recognised(self):
        # These are what the old mapping listened for; 6.1.0 never emits them.
        for action in ("sql_json", "sqllab_viz", "csv", "export_csv", "csv_endpoint"):
            self.assertIsNone(self.config.classify_audit_event(action, {}), action)

    def test_missing_record_does_not_raise(self):
        self.assertIsNone(self.config.classify_audit_event("SqlLabRestApi.get_results", None))


@unittest.skipUnless(
    importlib.util.find_spec("flask") is not None
    and importlib.util.find_spec("superset") is not None,
    "needs Flask and Superset (runs in the built image)",
)
class ChartExportThroughLogger(unittest.TestCase):
    """The audit logger, driven with real request shapes (#709)."""

    @classmethod
    def setUpClass(cls):
        cls._saved = {k: os.environ.get(k) for k in (*ENV, "SUPERSET_OAUTH_CLIENT_ID")}
        os.environ.update(ENV)
        # The audit logger belongs to the Stage 2 block, which only loads when
        # OAuth is configured.
        os.environ["SUPERSET_OAUTH_CLIENT_ID"] = "test-client"
        importlib.import_module("superset.config")
        sys.modules.pop("superset_config", None)  # an earlier class loaded it without OAuth
        sys.path.insert(0, str(HERE))
        cls.config = importlib.import_module("superset_config")
        sys.path.remove(str(HERE))
        from flask import Flask

        cls.app = Flask(__name__)

    @classmethod
    def tearDownClass(cls):
        sys.modules.pop("superset_config", None)
        for k, v in cls._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def audited(self, request_ctx, action, record):
        """What the logger would append to the platform audit store."""
        from unittest import mock

        logger = self.config.EVENT_LOGGER
        seen = []
        with mock.patch("superset.utils.log.DBEventLogger.log"), mock.patch.object(
            logger, "_append_platform_audit", lambda mapped, rec, kw: seen.append(mapped)
        ), request_ctx:
            logger.log(7, action, records=[record])
        return seen

    def form_post(self, result_format):
        payload = {"datasource": {"id": 8, "type": "table"}, "queries": [{}], "result_format": result_format}
        return self.app.test_request_context(
            "/api/v1/chart/data", method="POST", data={"form_data": json.dumps(payload)}
        )

    def test_the_csv_button_is_audited_as_an_export(self):
        seen = self.audited(self.form_post("csv"), "ChartDataRestApi.data", CHART_CSV_BUTTON_RECORD)
        self.assertEqual(seen, ["reporting.exported"])

    def test_the_xlsx_button_is_audited_as_an_export(self):
        seen = self.audited(self.form_post("xlsx"), "ChartDataRestApi.data", CHART_CSV_BUTTON_RECORD)
        self.assertEqual(seen, ["reporting.exported"])

    def test_the_record_alone_cannot_tell_the_button_from_a_dashboard_load(self):
        # The reason the logger reads the request: this is all the record holds.
        self.assertIsNone(
            self.config.classify_audit_event("ChartDataRestApi.data", CHART_CSV_BUTTON_RECORD)
        )

    def test_a_json_body_export_is_audited(self):
        ctx = self.app.test_request_context(
            "/api/v1/chart/data", method="POST", json={"queries": [{}], "result_format": "csv"}
        )
        self.assertEqual(
            self.audited(ctx, "ChartDataRestApi.data", {"path": "/api/v1/chart/data"}),
            ["reporting.exported"],
        )

    def test_a_get_with_format_is_audited(self):
        ctx = self.app.test_request_context("/api/v1/chart/5/data/?format=csv")
        self.assertEqual(
            self.audited(ctx, "ChartDataRestApi.data", {"path": "/api/v1/chart/5/data/"}),
            ["reporting.exported"],
        )

    def test_a_normal_dashboard_load_is_not_audited(self):
        for ctx in (
            self.form_post("json"),
            self.app.test_request_context("/api/v1/chart/data", method="POST", json={"result_format": "json"}),
            self.app.test_request_context("/api/v1/chart/5/data/"),
        ):
            self.assertEqual(self.audited(ctx, "ChartDataRestApi.data", CHART_CSV_BUTTON_RECORD), [])

    def test_an_unreadable_form_body_is_not_audited_and_does_not_raise(self):
        ctx = self.app.test_request_context(
            "/api/v1/chart/data", method="POST", data={"form_data": "{not json"}
        )
        self.assertEqual(self.audited(ctx, "ChartDataRestApi.data", CHART_CSV_BUTTON_RECORD), [])

    def test_other_events_do_not_read_the_request(self):
        # Only the chart-data event needs the request; a csv form post on any
        # other event must not turn into an export.
        self.assertEqual(self.audited(self.form_post("csv"), "welcome", {"path": "/superset/welcome/"}), [])


class Role:
    def __init__(self, name):
        self.name = name


class User:
    def __init__(self, username, roles, uid=7):
        self.username = username
        self.roles = [Role(r) for r in roles]
        self.id = uid


class AuditActor(AuditMapping):
    """The audit trail is keyed to the Zitadel subject, never the login name (T11)."""

    def actor(self, user):
        return self.config.audit_actor(user)

    def test_subject_marker_is_preferred(self):
        user = User("b-user", ["ReportingAnalyst", "owsub:393014046795759618", "owuser:111"])
        self.assertEqual(self.actor(user), "393014046795759618")

    def test_staff_with_only_a_marker_is_identified(self):
        user = User("owAdmin", ["ReportingStaff", "owsub:386221898641440771"])
        self.assertEqual(self.actor(user), "386221898641440771")

    def test_user_who_has_not_logged_in_since_the_marker_falls_back_to_own_rows_subject(self):
        user = User("testUser5", ["ReportingAnalyst", "owuser:386221898641440771"])
        self.assertEqual(self.actor(user), "386221898641440771")

    def test_unmarked_staff_falls_back_to_superset_id_not_the_login_name(self):
        user = User("owAdmin", ["ReportingStaff"], uid=4)
        actor = self.actor(user)
        self.assertEqual(actor, "superset-user:4")
        self.assertNotIn("owAdmin", actor)

    def test_two_markers_is_a_broken_account_and_is_not_guessed(self):
        user = User("dup", ["owsub:1", "owsub:2"], uid=9)
        self.assertEqual(self.actor(user), "superset-user:9")

    def test_unusable_subject_is_not_recorded(self):
        user = User("odd", ["owsub:has space;drop"], uid=3)
        self.assertEqual(self.actor(user), "superset-user:3")

    def test_the_login_name_is_never_returned(self):
        for roles in ([], ["owsub:5"], ["owuser:5"], ["owsub:1", "owsub:2"]):
            self.assertNotEqual(self.actor(User("secret-login", roles)), "secret-login")

    def test_marker_prefix_cannot_be_mistaken_for_own_rows_scoping(self):
        # `owuser:` narrows what a session may see; `owsub:` must never match it.
        self.assertFalse("owsub:5".startswith(self.config._OWN_ROWS_PREFIX))
        self.assertFalse("owuser:5".startswith(self.config.SUBJECT_ROLE_PREFIX))


if __name__ == "__main__":
    unittest.main()
