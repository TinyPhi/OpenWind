"""Cross-tenant abuse tests for Stage 2 (the standalone spec's T17, "ST17").

What a signed-in analyst could try against the tenant boundary, and that each
attempt fails closed (docs/specs/superset-gdpr-erasure-tasks.md T5-T8):

- T5 forged login: a token Zitadel refuses yields no identity and no user.
- T6 filter dodging: SQL written to reach another tenant (its id in WHERE,
  SET/RESET/set_config on the stamped settings, a CTE, a UNION, the base
  tables) returns that tenant's rows as 0, never an error that leaks them.
- T7 export attribution: an audit row written by tenant B's session is tenant B,
  and asking the writer for tenant A is refused.
- T8 username collision: a username equal to another tenant's id is never what
  stamps the connection; only the tenant role is.

T5 and T8 need only Flask (the Superset image). T6 and T7 need a real platform
database with migrations applied and data for two tenants:

    REPORTING_TEST_DATABASE_URL        analytics_user on the platform database
    REPORTING_TEST_ADMIN_DATABASE_URL  a role that may read and clean admin_audit_log
    REPORTING_BINDING_SECRET           the key installed in that database
    REPORTING_TEST_TENANT              a tenant with reporting rows
    REPORTING_TEST_OTHER_TENANT        a second tenant with reporting rows

    python -m unittest test_abuse_st17
"""

import contextlib
import importlib
import importlib.util
import json
import os
import sys
import unittest
import uuid
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
REAL = ("REPORTING_TEST_DATABASE_URL", "REPORTING_TEST_ADMIN_DATABASE_URL",
        "REPORTING_BINDING_SECRET", "REPORTING_TEST_TENANT", "REPORTING_TEST_OTHER_TENANT")
# Read at import, as test_audit_realdb does: other modules overwrite it while they run.
BINDING_SECRET = os.environ.get("REPORTING_BINDING_SECRET", "")
TENANT_A = "00000000-0000-0000-0000-000000000001"
TENANT_B = "bbbbbbbb-0002-4000-b000-000000000002"


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


def load_config(binding_secret):
    saved = {k: os.environ.get(k) for k in (
        "SUPERSET_SECRET_KEY", "SUPERSET_GUEST_TOKEN_SECRET", "DATABASE_URL",
        "REDIS_URL", "SUPERSET_OAUTH_CLIENT_ID", "REPORTING_BINDING_SECRET")}
    os.environ.update({
        "REPORTING_BINDING_SECRET": binding_secret,
        "SUPERSET_SECRET_KEY": "x",
        "SUPERSET_GUEST_TOKEN_SECRET": "y",
        "DATABASE_URL": "postgresql://u:p@localhost/db",
        "REDIS_URL": "redis://localhost:6379/0",
        # The login and audit code are part of the Stage 2 block.
        "SUPERSET_OAUTH_CLIENT_ID": "test-client",
    })
    importlib.import_module("superset.config")
    sys.modules.pop("superset_config", None)
    sys.path.insert(0, str(HERE))
    try:
        return importlib.import_module("superset_config"), saved
    finally:
        sys.path.remove(str(HERE))


def restore(saved):
    sys.modules.pop("superset_config", None)
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


@unittest.skipUnless(importlib.util.find_spec("flask") is not None, "needs Flask (runs in the image)")
class LoginAndStamp(unittest.TestCase):
    """T5 and T8: no database needed."""

    @classmethod
    def setUpClass(cls):
        cls.config, cls._saved = load_config("z" * 32)
        from flask import Flask

        cls.app = Flask(__name__)

    @classmethod
    def tearDownClass(cls):
        restore(cls._saved)

    # ── T5: a forged login ───────────────────────────────────────────────────
    def userinfo(self, status, body):
        """oauth_user_info as Superset calls it, with Zitadel's userinfo reply stubbed."""
        reply = mock.Mock(status_code=status)
        reply.json.return_value = body
        fake = mock.Mock()
        fake.appbuilder.sm.oauth_remotes = {"zitadel": mock.Mock(get=mock.Mock(return_value=reply))}
        return self.config.CUSTOM_SECURITY_MANAGER.oauth_user_info(fake, "zitadel")

    def test_a_token_zitadel_refuses_yields_no_identity(self):
        # The live reply to an edited, unsigned token (checked against Zitadel v4.15.1).
        refused = {"error": "access_denied", "error_description": "access token invalid"}
        self.assertEqual(self.userinfo(401, refused), {})

    def test_no_reply_status_is_treated_as_accepted(self):
        for status in (400, 403, 500, None):
            with self.subTest(status=status):
                self.assertEqual(self.userinfo(status, {"sub": "1", "preferred_username": "x"}), {})

    def test_a_refused_login_creates_no_user(self):
        from flask_appbuilder.security.manager import BaseSecurityManager

        security_manager = mock.Mock()
        self.assertIsNone(BaseSecurityManager.auth_user_oauth(security_manager, self.userinfo(401, {})))
        security_manager.add_user.assert_not_called()
        security_manager.find_user.assert_not_called()

    def test_an_accepted_login_still_reads_the_claims(self):
        claims = {
            "sub": "386221886528290819", "preferred_username": "testUser2",
            "urn:zitadel:iam:user:resourceowner:id": "386221592826937347",
            "urn:zitadel:iam:org:project:roles": {"user": {}},
        }
        info = self.userinfo(200, claims)
        self.assertEqual((info["subject_id"], info["username"], info["role_keys"]),
                         ("386221886528290819", "testUser2", ["user"]))

    # ── T8: a username that looks like another tenant ────────────────────────
    def stamp(self, user, username=None, guest_token_tenant=None):
        """The options DB_CONNECTION_MUTATOR stamps, with `user` as the request's user.

        `username` is what Superset passes the mutator (the signed-in user's name,
        or the guest pass name on the embedded path)."""
        from flask import g

        with self.app.test_request_context("/"):
            g.user = user
            with mock.patch("flask_login.current_user", Unauthenticated()), \
                    mock.patch.object(self.config, "_tenant_from_guest_token",
                                      return_value=guest_token_tenant):
                _, params = self.config.DB_CONNECTION_MUTATOR(
                    None, {}, user.username if username is None else username, object(), None)
        return params.get("connect_args", {}).get("options", "")

    def test_the_embedded_guest_pass_still_stamps_its_tenant(self):
        # The embedded path: Superset's guest user is not signed in, and the
        # name it passes is the tenant id the API minted into the guest pass.
        guest = mock.Mock(is_authenticated=False, is_guest_user=True, roles=[])
        self.assertIn(f"app.tenant_id={TENANT_A}", self.stamp(guest, username=TENANT_A))

    def test_a_dashboard_query_run_as_the_owner_takes_the_guest_tokens_tenant(self):
        # Native filter values run as the dashboard owner (the service account);
        # the tenant comes from the verified guest token on the request.
        owner = User("service_account", ["ReportingServiceAccount"])
        self.assertIn(f"app.tenant_id={TENANT_B}", self.stamp(owner, guest_token_tenant=TENANT_B))

    def test_a_username_equal_to_another_tenants_id_does_not_stamp_that_tenant(self):
        options = self.stamp(User(TENANT_A, ["ReportingAnalyst", f"tenant:{TENANT_B}"]))
        self.assertIn(f"app.tenant_id={TENANT_B}", options)
        self.assertNotIn(TENANT_A, options)

    def test_a_tenant_shaped_username_with_no_tenant_role_stamps_nothing(self):
        self.assertEqual(self.stamp(User(TENANT_A, ["ReportingAnalyst"])), "")

    def test_a_role_named_like_a_tenant_but_malformed_stamps_nothing(self):
        for role in (f"tenant:{TENANT_A}' -c app.tenant_id={TENANT_B}",
                     f"tenant:{TENANT_A} ", "tenant:not-a-uuid", f"Tenant:{TENANT_A}"):
            with self.subTest(role=role):
                self.assertNotIn("app.tenant_id=", self.stamp(User("ana", ["ReportingAnalyst", role])))


@unittest.skipUnless(
    importlib.util.find_spec("flask") is not None and all(os.environ.get(k) for k in REAL),
    "needs the Superset image and a real platform database with two tenants (see module docstring)",
)
class AgainstRealDatabase(unittest.TestCase):
    """T6 and T7: the real mutator, signature and RLS on a real platform database."""

    @classmethod
    def setUpClass(cls):
        cls.config, cls._saved = load_config(BINDING_SECRET)
        from flask import Flask
        from sqlalchemy import create_engine

        cls.app = Flask(__name__)
        cls.a = os.environ["REPORTING_TEST_TENANT"]
        cls.b = os.environ["REPORTING_TEST_OTHER_TENANT"]
        cls.admin = create_engine(os.environ["REPORTING_TEST_ADMIN_DATABASE_URL"])

    @classmethod
    def tearDownClass(cls):
        cls.admin.dispose()
        restore(cls._saved)

    def session(self, tenant, own_subject=None, username="abuse-test"):
        """An engine whose connections are stamped by the real mutator for a signed-in user of
        `tenant` called `username` (Superset passes the mutator the signed-in user's name)."""
        from flask import g
        from sqlalchemy import create_engine
        from sqlalchemy.pool import NullPool

        roles = ["ReportingAnalyst", f"tenant:{tenant}"]
        if own_subject:
            roles.append(f"owuser:{own_subject}")
        with self.app.test_request_context("/api/v1/sqllab/execute/", method="POST"):
            g.user = User(username, roles)
            with mock.patch("flask_login.current_user", Unauthenticated()):
                _, params = self.config.DB_CONNECTION_MUTATOR(None, {}, username, object(), None)
        return create_engine(os.environ["REPORTING_TEST_DATABASE_URL"], poolclass=NullPool,
                             connect_args=params.get("connect_args", {}))

    def scalar(self, engine, *statements):
        """Run statements on one connection, as one SQL Lab tab would; return the last result."""
        from sqlalchemy import text

        with engine.connect() as conn:
            result = None
            for statement in statements:
                result = conn.execute(text(statement))
            return result.scalar()

    # ── T6: filter dodging ───────────────────────────────────────────────────
    def test_the_session_sees_its_own_tenant(self):
        # Without this baseline every "0 rows" below could just mean "no data".
        engine = self.session(self.a)
        self.assertGreater(self.scalar(engine, "SELECT count(*) FROM reporting_instances"), 0)
        self.assertGreater(self.scalar(self.session(self.b), "SELECT count(*) FROM reporting_instances"), 0)
        self.assertEqual(self.scalar(
            engine, "SELECT count(DISTINCT tenant_id) FROM reporting_instances"), 1)

    def test_queries_written_to_reach_another_tenant_return_nothing(self):
        engine = self.session(self.a)
        b = self.b
        attacks = {
            "other tenant's id in WHERE":
                [f"SELECT count(*) FROM reporting_instances WHERE tenant_id = '{b}'"],
            "OR true in WHERE":
                [f"SELECT count(*) FROM reporting_instances WHERE tenant_id = '{b}' OR true"
                 f" AND tenant_id <> '{self.a}'"],
            "SET app.tenant_id":
                [f"SET app.tenant_id = '{b}'", "SELECT count(*) FROM reporting_instances"],
            "set_config()":
                [f"SELECT set_config('app.tenant_id', '{b}', false)",
                 "SELECT count(*) FROM reporting_instances"],
            "RESET then SET":
                ["RESET app.tenant_id", f"SET app.tenant_id = '{b}'",
                 "SELECT count(*) FROM reporting_instances"],
            # RESET returns to the value the session started with: the signed,
            # own tenant. So the own rows stay visible; the other tenant's do not.
            "RESET ALL":
                ["RESET ALL", f"SELECT count(*) FROM reporting_instances WHERE tenant_id = '{b}'"],
            "CTE":
                [f"WITH r AS (SELECT * FROM reporting_instances) SELECT count(*) FROM r WHERE tenant_id = '{b}'"],
            "UNION over the view and a base table":
                [f"SELECT count(*) FROM (SELECT tenant_id FROM reporting_instances UNION ALL"
                 f" SELECT tenant_id FROM entity_instances) u WHERE tenant_id = '{b}'"],
            "base table entity_instances":
                [f"SELECT count(*) FROM entity_instances WHERE tenant_id = '{b}'"],
            "base table workflow_events":
                [f"SELECT count(*) FROM workflow_events WHERE tenant_id = '{b}'"],
        }
        for name, statements in attacks.items():
            with self.subTest(attack=name):
                self.assertEqual(self.scalar(engine, *statements), 0)

    def test_a_username_set_to_another_tenants_id_does_not_reach_that_tenant(self):
        # T8 end to end: a tenant-A analyst whose Zitadel username is tenant B's id.
        engine = self.session(self.a, username=self.b)
        self.assertEqual(self.scalar(
            engine, f"SELECT count(*) FROM reporting_instances WHERE tenant_id = '{self.b}'"), 0)
        self.assertGreater(self.scalar(
            engine, f"SELECT count(*) FROM reporting_instances WHERE tenant_id = '{self.a}'"), 0)

    def test_changing_the_settings_sees_nothing_at_all(self):
        # After tampering the session is not "another tenant", it is no tenant.
        engine = self.session(self.a)
        for tamper in (f"SET app.tenant_id = '{self.b}'", "SET app.reporting_binding_sig = 'forged'",
                       "SET app.reporting_user_id = 'someone-else'"):
            with self.subTest(tamper=tamper):
                self.assertEqual(self.scalar(engine, tamper, "SELECT count(*) FROM reporting_instances"), 0)

    def test_an_own_rows_session_cannot_widen_to_the_tenant(self):
        from sqlalchemy import text

        # A real creator who owns some of the tenant's tickets, not all of them.
        with self.admin.connect() as conn:
            subject = conn.execute(text(
                "SELECT created_by FROM entity_instances WHERE tenant_id = :t AND created_by IS NOT NULL"
                " GROUP BY created_by ORDER BY count(*) LIMIT 1"), {"t": self.a}).scalar()
        self.assertIsNotNone(subject, "tenant has no ticket with a creator")
        whole = self.scalar(self.session(self.a), "SELECT count(*) FROM reporting_instances")
        own = self.session(self.a, own_subject=subject)
        mine = self.scalar(own, "SELECT count(*) FROM reporting_instances")
        self.assertGreater(mine, 0)
        self.assertLess(mine, whole, "own-rows session sees the whole tenant")
        for widen in ("SET app.reporting_scope = 'tenant'", "SET app.reporting_user_id = ''",
                      "SET app.reporting_scope = ''"):
            with self.subTest(widen=widen):
                self.assertEqual(self.scalar(own, widen, "SELECT count(*) FROM reporting_instances"), 0)

    # ── T7: export attribution ───────────────────────────────────────────────
    def audit_rows(self, actor):
        from sqlalchemy import text

        with self.admin.connect() as conn:
            return conn.execute(text(
                "SELECT tenant_id::text FROM admin_audit_log WHERE actor_id = :a"), {"a": actor}).fetchall()

    def test_an_export_by_tenant_b_is_recorded_as_tenant_b(self):
        from sqlalchemy import text

        actor = f"ST17TEST{uuid.uuid4().hex[:12]}"
        engine = self.session(self.b)
        try:
            with engine.begin() as conn:
                conn.execute(text("SELECT public.record_reporting_audit(:t, :a, 'reporting.exported',"
                                  " CAST(:m AS jsonb))"),
                             {"t": self.b, "a": actor, "m": json.dumps({"st17": True})})
            self.assertEqual(self.audit_rows(actor), [(self.b,)])
        finally:
            self.clean(actor)

    def test_tenant_b_cannot_write_an_audit_row_for_tenant_a(self):
        from sqlalchemy import text

        actor = f"ST17TEST{uuid.uuid4().hex[:12]}"
        engine = self.session(self.b)
        try:
            with self.assertRaises(Exception):
                with engine.begin() as conn:
                    conn.execute(text("SELECT public.record_reporting_audit(:t, :a, 'reporting.exported',"
                                      " CAST(:m AS jsonb))"),
                                 {"t": self.a, "a": actor, "m": json.dumps({"st17": True})})
            self.assertEqual(self.audit_rows(actor), [])
        finally:
            self.clean(actor)

    def test_a_tampered_session_cannot_write_audit_rows_at_all(self):
        from sqlalchemy import text

        actor = f"ST17TEST{uuid.uuid4().hex[:12]}"
        engine = self.session(self.b)
        try:
            with self.assertRaises(Exception):
                with engine.begin() as conn:
                    conn.execute(text(f"SET app.tenant_id = '{self.a}'"))
                    conn.execute(text("SELECT public.record_reporting_audit(:t, :a, 'reporting.exported',"
                                      " CAST(:m AS jsonb))"),
                                 {"t": self.a, "a": actor, "m": json.dumps({"st17": True})})
            self.assertEqual(self.audit_rows(actor), [])
        finally:
            self.clean(actor)

    def clean(self, actor):
        from sqlalchemy import text

        with contextlib.suppress(Exception), self.admin.begin() as conn:
            conn.execute(text("DELETE FROM admin_audit_log WHERE actor_id = :a"), {"a": actor})


if __name__ == "__main__":
    unittest.main()
