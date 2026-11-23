"""What Superset writes to its logs (#1140, ADR-019 Stage 2 criterion on process logs).

The runbook attests what reaches stdout and stderr, so these pin the behaviour it describes:
the audit-failure log carries no SQL or bound parameters, no logger call names a login name or an
email or writes a traceback, and Flask-AppBuilder's sign-in errors lose their values. The compose
files (log rotation, the access-log format) are pinned in apps/worker/src/superset-compose-logging.test.ts,
because this file also runs in the built-image harness, which mounts only docker/superset.

Run: python3 -m unittest docker/superset/test_log_hygiene.py
"""

import ast
import logging
import os
import re
import unittest
from pathlib import Path

from test_audit_mapping import ENV, load_config

HERE = Path(__file__).resolve().parent


class AuditFailureLog(unittest.TestCase):
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

    def test_the_failure_log_carries_the_action_and_exception_type_only(self):
        # A DBAPIError message includes the statement and its bound parameters, which here are the
        # audit row's meta JSON, whose "sql" field is the user's query.
        query = "SELECT * FROM users WHERE email = 'victim@example.com'"
        exc = RuntimeError(
            "(psycopg2.OperationalError) connection refused\n"
            f"[SQL: INSERT INTO admin_audit_log (metadata) VALUES (%(m)s)]\n"
            f"[parameters: {{'m': '{{\"sql\": \"{query}\"}}'}}]"
        )
        with self.assertLogs(self.config.logger, level="ERROR") as captured:
            self.config.log_audit_write_failure("reporting.query_executed", exc)
        text = "\n".join(captured.output)
        self.assertIn("reporting.query_executed", text)
        self.assertIn("RuntimeError", text)
        for leaked in ("victim@example.com", "SELECT", "parameters", "INSERT", "[SQL"):
            self.assertNotIn(leaked, text)
        self.assertIsNone(captured.records[0].exc_info)

    def test_no_logger_call_names_a_login_name_or_an_email(self):
        # Superset's username is the Zitadel preferred_username in Stage 2: usually a login name or an
        # email address. These logs are never erased, so no call may carry it.
        tree = ast.parse((HERE / "superset_config.py").read_text())
        offenders = []
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "logger"
            ):
                call = ast.unparse(node)
                if re.search(r"preferred_username|\busername\b|\bemail\b", call):
                    offenders.append(call)
        self.assertEqual(offenders, [])

    def test_no_logger_call_writes_a_traceback_or_exception_text(self):
        # A SQLAlchemy error message carries the statement's bound parameters (a subject id, a
        # username, an email, SQL text) and nothing here sets hide_parameters, so a traceback logged
        # during a database error leaks them. Failures are logged by type through log_error_type.
        tree = ast.parse((HERE / "superset_config.py").read_text())
        offenders = []
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "logger"
            ):
                if node.func.attr == "exception" or any(
                    k.arg == "exc_info" for k in node.keywords
                ):
                    offenders.append(ast.unparse(node))
        self.assertEqual(offenders, [])

    def test_error_type_logging_carries_the_type_and_not_the_text(self):
        exc = RuntimeError("[parameters: {'owsub': 'owsub:zitadel-subject-42'}]")
        with self.assertLogs(self.config.logger, level="ERROR") as captured:
            self.config.log_error_type(
                "superset erasure failed: tenant=%s subject=%s", exc, "t-1", "yes"
            )
        text = "\n".join(captured.output)
        self.assertIn("tenant=t-1 subject=yes (RuntimeError)", text)
        self.assertNotIn("zitadel-subject-42", text)
        self.assertIsNone(captured.records[0].exc_info)

    def test_error_type_logging_says_where_the_error_was_raised_without_its_text(self):
        def raiser():
            raise RuntimeError("[parameters: {'owsub': 'owsub:zitadel-subject-42'}]")

        try:
            raiser()
        except RuntimeError as exc:
            with self.assertLogs(self.config.logger, level="ERROR") as captured:
                self.config.log_error_type("failed: %s", exc, "x")
        text = "\n".join(captured.output)
        self.assertRegex(text, r"failed: x \(RuntimeError at test_log_hygiene\.py:\d+\)")
        self.assertNotIn("zitadel-subject-42", text)

    def test_flask_appbuilder_sign_in_logs_keep_the_message_and_lose_the_values(self):
        for name, message, value in (
            (
                "flask_appbuilder.security.manager",
                "OAUTH userinfo does not have username or email %s",
                {"email": "victim@example.com", "given_name": "Jane"},
            ),
            (
                "flask_appbuilder.security.manager",
                "Error creating a new OAuth user %s",
                "jane.doe@example.com",
            ),
            (
                "flask_appbuilder.security.sqla.manager",
                "Multiple results found for user with email %s",
                "victim@example.com",
            ),
        ):
            with self.subTest(message=message):
                with self.assertLogs(name, level="ERROR") as captured:
                    logging.getLogger(name).error(message, value)
                text = "\n".join(captured.output)
                self.assertIn(message.split(" %s")[0], text)
                self.assertIn("[REDACTED]", text)
                for leaked in ("victim@example.com", "jane.doe@example.com", "Jane"):
                    self.assertNotIn(leaked, text)

    def test_flask_appbuilder_failed_add_user_loses_the_exception_text_and_traceback(self):
        name = "flask_appbuilder.security.sqla.manager"
        with self.assertLogs(name, level="ERROR") as captured:
            try:
                raise RuntimeError("[parameters: {'email': 'victim@example.com'}]")
            except RuntimeError as exc:
                logging.getLogger(name).error(
                    "Error adding new user to database. %s", exc, exc_info=True
                )
        self.assertNotIn("victim@example.com", "\n".join(captured.output))
        self.assertIsNone(captured.records[0].exc_info)

    def test_the_audit_write_failure_path_does_not_log_the_exception_itself(self):
        source = (HERE / "superset_config.py").read_text()
        self.assertIn("log_audit_write_failure(mapped, exc)", source)
        self.assertNotIn("failed to record '%s' in the platform audit store\", mapped", source)


if __name__ == "__main__":
    unittest.main()
