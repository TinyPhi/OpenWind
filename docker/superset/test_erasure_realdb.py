"""Superset erasure against a real Superset schema (#728, spec R1-R5, T13, T19).

Seeds users with a row in every table the erase handles, erases one user or a
whole tenant, and checks that exactly their data is gone and nobody else's is.
Also guards the classification: a new reference to `ab_user` that is neither
handled nor exempt fails the build.

Needs a throwaway database with Superset's schema and no data you care about,
for example a schema-only copy of the metadata database:

    createdb -O superset_user superset_erasetest
    pg_dump --schema-only --no-owner --no-acl superset | psql -d superset_erasetest

Runs inside the Superset image:

    SUPERSET_ERASURE_TEST_DATABASE_URL=postgresql://.../superset_erasetest \
        python -m unittest test_erasure_realdb

Optionally SUPERSET_ERASURE_TEST_REDIS_URL (an empty Redis db) for the cache flush.
"""

import importlib
import importlib.util
import os
import sys
import unittest
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
DB_URL = os.environ.get("SUPERSET_ERASURE_TEST_DATABASE_URL", "")
REDIS_URL = os.environ.get("SUPERSET_ERASURE_TEST_REDIS_URL", "")


def _rand(prefix=""):
    return prefix + uuid.uuid4().hex[:12]


@unittest.skipUnless(
    importlib.util.find_spec("flask") is not None and DB_URL,
    "needs the Superset image and SUPERSET_ERASURE_TEST_DATABASE_URL",
)
class Erasure(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        keys = ("SUPERSET_SECRET_KEY", "SUPERSET_GUEST_TOKEN_SECRET", "DATABASE_URL",
                "REDIS_URL", "REPORTING_BINDING_SECRET")
        cls._saved = {k: os.environ.get(k) for k in keys}
        os.environ.update({
            "REPORTING_BINDING_SECRET": "z" * 32,
            "SUPERSET_SECRET_KEY": "x",
            "SUPERSET_GUEST_TOKEN_SECRET": "y",
            "DATABASE_URL": DB_URL,
            "REDIS_URL": REDIS_URL or "redis://localhost:6379/15",
        })
        importlib.import_module("superset.config")
        sys.modules.pop("superset_config", None)
        sys.path.insert(0, str(HERE))
        try:
            cls.config = importlib.import_module("superset_config")
        finally:
            sys.path.remove(str(HERE))
        from sqlalchemy import create_engine

        cls.engine = create_engine(DB_URL)

    @classmethod
    def tearDownClass(cls):
        cls.engine.dispose()
        sys.modules.pop("superset_config", None)
        for k, v in cls._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    # ── seeding ────────────────────────────────────────────────────────────────
    def sql(self, statement, **params):
        from sqlalchemy import text

        with self.engine.begin() as conn:
            result = conn.execute(text(statement), params)
            return result.scalar() if result.returns_rows else None

    def role(self, name):
        found = self.sql("SELECT id FROM ab_role WHERE name = :n", n=name)
        return found or self.sql(
            "INSERT INTO ab_role (id, name) VALUES (nextval('ab_role_id_seq'), :n) RETURNING id", n=name)

    def user(self, roles, username=None):
        """A Superset user holding `roles`, with a row in every handled table."""
        uid = self.sql(
            "INSERT INTO ab_user (id, first_name, last_name, username, email, active, password)"
            " VALUES (nextval('ab_user_id_seq'), 'Real', 'Person', :u, :e, true, 'hash') RETURNING id",
            u=username or _rand("user-"), e=_rand() + "@example.test")
        for name in roles:
            self.sql("INSERT INTO ab_user_role (id, user_id, role_id)"
                     " VALUES (nextval('ab_user_role_id_seq'), :u, :r)", u=uid, r=self.role(name))
        self.seed_rows(uid)
        return uid

    def seed_rows(self, uid):
        s, u = self.sql, uid
        db = s("INSERT INTO dbs (database_name, sqlalchemy_uri) VALUES (:n, 'sqlite://') RETURNING id",
               n=_rand("db-"))
        s("INSERT INTO query (client_id, database_id, user_id, sql) VALUES (:c, :d, :u, 'SELECT 1')",
          c=_rand()[:11], d=db, u=u)
        s("INSERT INTO saved_query (user_id, db_id, label, sql) VALUES (:u, :d, 'mine', 'SELECT 1')", u=u, d=db)
        tab = s("INSERT INTO tab_state (autorun, user_id, label) VALUES (false, :u, 'tab') RETURNING id", u=u)
        s("INSERT INTO table_schema (database_id, tab_state_id) VALUES (:d, :t)", d=db, t=tab)
        for _ in range(3):
            s("INSERT INTO logs (user_id, action, dttm) VALUES (:u, 'execute_sql', now())", u=u)
        s("INSERT INTO favstar (user_id, class_name, obj_id) VALUES (:u, 'Dashboard', 1)", u=u)
        s("INSERT INTO user_attribute (user_id) VALUES (:u)", u=u)
        tag = s("INSERT INTO tag (name) VALUES (:n) RETURNING id", n=_rand("tag-"))
        s("INSERT INTO user_favorite_tag (user_id, tag_id) VALUES (:u, :t)", u=u, t=tag)
        task = s("INSERT INTO tasks (uuid, task_key, task_type, status, dedup_key, user_id)"
                 " VALUES (gen_random_uuid(), :k, 't', 'done', :k, :u) RETURNING id", k=_rand(), u=u)
        s("INSERT INTO task_subscribers (task_id, user_id, subscribed_at) VALUES (:t, :u, now())", t=task, u=u)
        s("INSERT INTO database_user_oauth2_tokens (user_id, database_id) VALUES (:u, :d)", u=u, d=db)
        group = s("INSERT INTO ab_group (id, name) VALUES (nextval('ab_group_id_seq'), :n) RETURNING id",
                  n=_rand("group-"))
        s("INSERT INTO ab_user_group (id, user_id, group_id) VALUES (nextval('ab_user_group_id_seq'), :u, :g)",
          u=u, g=group)
        dash = s("INSERT INTO dashboards DEFAULT VALUES RETURNING id")
        s("INSERT INTO dashboard_user (user_id, dashboard_id) VALUES (:u, :d)", u=u, d=dash)
        chart = s("INSERT INTO slices DEFAULT VALUES RETURNING id")
        s("INSERT INTO slice_user (user_id, slice_id) VALUES (:u, :c)", u=u, c=chart)
        table = s("INSERT INTO tables (table_name, database_id) VALUES (:n, :d) RETURNING id",
                  n=_rand("t_"), d=db)
        s("INSERT INTO sqlatable_user (user_id, table_id) VALUES (:u, :t)", u=u, t=table)
        report = s("INSERT INTO report_schedule (type, name, crontab, extra_json)"
                   " VALUES ('Report', :n, '0 * * * *', '{}') RETURNING id", n=_rand("report-"))
        s("INSERT INTO report_schedule_user (user_id, report_schedule_id) VALUES (:u, :r)", u=u, r=report)
        # The user's cached filter state (erased) and a shared permalink (kept).
        s("INSERT INTO key_value (resource, value, created_by_fk) VALUES ('superset_metastore_cache', 'x', :u)",
          u=u)
        s("INSERT INTO key_value (resource, value, created_by_fk) VALUES ('dashboard_permalink', 'x', :u)", u=u)

    # ── reading ────────────────────────────────────────────────────────────────
    def counts(self, uid):
        """Rows naming `uid` in every non-author reference the database has, plus
        the kept permalink. Read from the schema, not from the config under test,
        so a table the config forgets still shows up here."""
        from sqlalchemy import text

        with self.engine.connect() as conn:
            references = sorted(
                (table, column) for table, column in conn.execute(text(self.REFERENCES))
                if column not in self.config.ERASURE_EXEMPT_COLUMNS
            )
        out = {}
        for table, column in references:
            out[f"{table}.{column}"] = self.sql(f"SELECT count(*) FROM {table} WHERE {column} = :u", u=uid)
        out["key_value cache"] = self.sql(
            "SELECT count(*) FROM key_value WHERE resource = 'superset_metastore_cache'"
            " AND (created_by_fk = :u OR changed_by_fk = :u)", u=uid)
        out["key_value permalink"] = self.sql(
            "SELECT count(*) FROM key_value WHERE resource = 'dashboard_permalink' AND created_by_fk = :u", u=uid)
        return out

    def account(self, uid):
        from sqlalchemy import text

        with self.engine.connect() as conn:
            return dict(conn.execute(text(
                "SELECT username, email, first_name, last_name, active, password FROM ab_user WHERE id = :u"),
                {"u": uid}).mappings().one())

    def erase(self, tenant, subject=None, **kw):
        """Call until finished, as the worker does; returns (matched, deleted, calls)."""
        calls, deleted, matched = 0, 0, 0
        while True:
            calls += 1
            result = self.config.erase_superset_data(self.engine, tenant, subject, **kw)
            deleted += result["deletedRows"]
            matched = max(matched, result["matchedUsers"])
            if not result["more"]:
                return matched, deleted, calls
            self.assertLess(calls, 500, "erasure is not making progress")

    def tenant_and_subjects(self, n=1):
        return str(uuid.uuid4()), [str(uuid.uuid4().int)[:18] for _ in range(n)]

    def assert_erased(self, uid):
        counts = self.counts(uid)
        permalink = counts.pop("key_value permalink")
        self.assertEqual(counts, {k: 0 for k in counts}, "rows naming the user are left")
        self.assertEqual(permalink, 1, "a shared permalink was deleted")
        account = self.account(uid)
        self.assertEqual(account["username"], f"erased-{uid}")
        self.assertEqual(account["email"], f"erased-{uid}@erased.invalid")
        self.assertEqual((account["first_name"], account["last_name"]), ("erased", "-"))
        self.assertFalse(account["active"])
        self.assertIsNone(account["password"])

    def assert_untouched(self, uid, before):
        self.assertEqual(self.counts(uid), before)
        self.assertTrue(self.account(uid)["active"])

    # ── R1: one user ─────────────────────────────────────────────────────────────
    def test_seeding_reaches_every_handled_table(self):
        tenant, (subject,) = self.tenant_and_subjects()
        uid = self.user([f"owsub:{subject}", f"tenant:{tenant}"])
        empty = [t for t, n in self.counts(uid).items() if n == 0]
        self.assertEqual(empty, [], "a handled table has no seeded row, so the erase test proves nothing for it")

    def test_a_user_is_erased_from_every_table_and_nobody_else_is(self):
        tenant, (target, colleague) = self.tenant_and_subjects(2)
        other_tenant = str(uuid.uuid4())
        victim = self.user([f"owsub:{target}", f"owuser:{target}", f"tenant:{tenant}", "ReportingAnalyst"])
        same_tenant = self.user([f"owsub:{colleague}", f"tenant:{tenant}", "ReportingAnalyst"])
        elsewhere = self.user([f"owsub:{colleague}", f"tenant:{other_tenant}"])
        before = {u: self.counts(u) for u in (same_tenant, elsewhere)}

        matched, deleted, _ = self.erase(tenant, target)

        self.assertEqual(matched, 1)
        self.assertGreater(deleted, 0)
        self.assert_erased(victim)
        for u, counts in before.items():
            self.assert_untouched(u, counts)
        # The per-subject roles are gone; the shared tenant role is not.
        self.assertIsNone(self.sql("SELECT id FROM ab_role WHERE name = :n", n=f"owsub:{target}"))
        self.assertIsNone(self.sql("SELECT id FROM ab_role WHERE name = :n", n=f"owuser:{target}"))
        self.assertIsNotNone(self.sql("SELECT id FROM ab_role WHERE name = :n", n=f"tenant:{tenant}"))

    def test_a_user_known_only_by_the_owuser_role_is_matched(self):
        tenant, (subject,) = self.tenant_and_subjects()
        uid = self.user([f"owuser:{subject}", f"tenant:{tenant}"])
        self.assertEqual(self.erase(tenant, subject)[0], 1)
        self.assert_erased(uid)

    # ── R2: a whole tenant ──────────────────────────────────────────────────────
    def test_a_tenant_erase_removes_every_user_of_that_tenant_only(self):
        tenant, (a, b) = self.tenant_and_subjects(2)
        other_tenant = str(uuid.uuid4())
        users = [self.user([f"owsub:{a}", f"tenant:{tenant}"]), self.user([f"tenant:{tenant}"])]
        outsider = self.user([f"owsub:{b}", f"tenant:{other_tenant}"])
        before = self.counts(outsider)

        matched, _, _ = self.erase(tenant)

        self.assertEqual(matched, 2)
        for u in users:
            self.assert_erased(u)
        self.assert_untouched(outsider, before)
        self.assertIsNone(self.sql("SELECT id FROM ab_role WHERE name = :n", n=f"tenant:{tenant}"))
        self.assertIsNotNone(self.sql("SELECT id FROM ab_role WHERE name = :n", n=f"tenant:{other_tenant}"))
        # The other tenant's user keeps their own subject role and its link.
        self.assertEqual(self.sql(
            "SELECT count(*) FROM ab_user_role ur JOIN ab_role r ON r.id = ur.role_id"
            " WHERE ur.user_id = :u AND r.name = :n", u=outsider, n=f"owsub:{b}"), 1)

    # ── R3: matching never trusts a name ────────────────────────────────────────
    def test_the_right_subject_in_the_wrong_tenant_is_not_matched(self):
        tenant, (subject,) = self.tenant_and_subjects()
        uid = self.user([f"owsub:{subject}", f"tenant:{tenant}"])
        before = self.counts(uid)
        self.assertEqual(self.erase(str(uuid.uuid4()), subject)[0], 0)
        self.assert_untouched(uid, before)

    def test_the_subjects_account_with_no_tenant_role_is_erased(self):
        # A login that resolved to no tenant keeps only `owsub:`. It belongs to
        # no other tenant, so a per-user erase takes it rather than leaving it.
        tenant, (subject,) = self.tenant_and_subjects()
        uid = self.user([f"owsub:{subject}"])
        result = self.config.erase_superset_data(self.engine, tenant, subject)
        self.assertEqual((result["matchedUsers"], result["heldUsers"]), (1, 0))
        self.assert_erased(uid)

    def test_the_subjects_account_now_in_another_tenant_is_held_not_erased(self):
        # The person moved org: erasing would remove their records in the other
        # tenant, so the account is left as it is and counted, never silent.
        tenant, (subject,) = self.tenant_and_subjects()
        uid = self.user([f"owsub:{subject}", f"tenant:{uuid.uuid4()}"])
        before = self.counts(uid)
        result = self.config.erase_superset_data(self.engine, tenant, subject)
        self.assertEqual((result["matchedUsers"], result["heldUsers"], result["more"]), (0, 1, False))
        self.assert_untouched(uid, before)

    def test_a_tenant_erase_leaves_accounts_with_no_tenant_role_alone(self):
        tenant, (subject,) = self.tenant_and_subjects()
        loose = self.user([f"owsub:{subject}"])
        before = self.counts(loose)
        result = self.config.erase_superset_data(self.engine, tenant)
        self.assertEqual(result["heldUsers"], 0)
        self.assert_untouched(loose, before)

    def test_a_username_equal_to_the_subject_is_not_matched(self):
        tenant, (subject,) = self.tenant_and_subjects()
        namesake = self.user([f"tenant:{tenant}"], username=subject)
        before = self.counts(namesake)
        self.assertEqual(self.erase(tenant, subject)[0], 0)
        self.assert_untouched(namesake, before)

    def test_admin_and_the_service_account_are_never_erased(self):
        tenant, (subject,) = self.tenant_and_subjects()
        admin = self.user([f"owsub:{subject}", f"tenant:{tenant}", "Admin"])
        service = self.user([f"tenant:{tenant}", "ReportingServiceAccount"])
        before = {u: self.counts(u) for u in (admin, service)}
        self.assertEqual(self.erase(tenant, subject)[0], 0)
        self.assertEqual(self.erase(tenant)[0], 0)
        for u, counts in before.items():
            self.assert_untouched(u, counts)

    def test_ids_that_are_not_ids_are_refused(self):
        with self.assertRaises(ValueError):
            self.config.erase_superset_data(self.engine, "not-a-uuid", "1")
        with self.assertRaises(ValueError):
            self.config.erase_superset_data(self.engine, str(uuid.uuid4()), "a b' OR 1=1 --")
        with self.assertRaises(ValueError):
            self.config.erase_superset_data(self.engine, str(uuid.uuid4()), ["1"])

    def test_a_role_a_protected_account_still_holds_keeps_its_rls_links(self):
        tenant, _ = self.tenant_and_subjects()
        self.user([f"tenant:{tenant}"])
        self.user([f"tenant:{tenant}", "Admin"])
        role = self.role(f"tenant:{tenant}")
        rls = self.sql("INSERT INTO row_level_security_filters (name, clause) VALUES (:n, '1=1') RETURNING id",
                       n=_rand("rls-"))
        self.sql("INSERT INTO rls_filter_roles (role_id, rls_filter_id) VALUES (:r, :f)", r=role, f=rls)
        self.assertEqual(self.erase(tenant)[0], 1)
        self.assertEqual(self.sql("SELECT count(*) FROM rls_filter_roles WHERE role_id = :r", r=role), 1)
        self.assertIsNotNone(self.sql("SELECT id FROM ab_role WHERE id = :r", r=role))

    def test_a_role_nobody_holds_any_more_goes_with_its_rls_links(self):
        tenant, _ = self.tenant_and_subjects()
        self.user([f"tenant:{tenant}"])
        role = self.role(f"tenant:{tenant}")
        rls = self.sql("INSERT INTO row_level_security_filters (name, clause) VALUES (:n, '1=1') RETURNING id",
                       n=_rand("rls-"))
        self.sql("INSERT INTO rls_filter_roles (role_id, rls_filter_id) VALUES (:r, :f)", r=role, f=rls)
        self.assertEqual(self.erase(tenant)[0], 1)
        self.assertEqual(self.sql("SELECT count(*) FROM rls_filter_roles WHERE role_id = :r", r=role), 0)
        self.assertIsNone(self.sql("SELECT id FROM ab_role WHERE id = :r", r=role))

    def test_a_role_with_dashboard_permission_and_group_links_still_goes(self):
        # The finishing step deletes the roles nobody holds any more in one
        # transaction with the anonymisation. A link that blocked the delete
        # would roll all of it back on every retry, so each kind of link is set.
        tenant, _ = self.tenant_and_subjects()
        uid = self.user([f"tenant:{tenant}"])
        role = self.role(f"tenant:{tenant}")
        dash = self.sql("INSERT INTO dashboards DEFAULT VALUES RETURNING id")
        self.sql("INSERT INTO dashboard_roles (role_id, dashboard_id) VALUES (:r, :d)", r=role, d=dash)
        perm = self.sql("INSERT INTO ab_permission (id, name) VALUES (nextval('ab_permission_id_seq'), :n)"
                        " RETURNING id", n=_rand("perm-"))
        view = self.sql("INSERT INTO ab_view_menu (id, name) VALUES (nextval('ab_view_menu_id_seq'), :n)"
                        " RETURNING id", n=_rand("view-"))
        pv = self.sql("INSERT INTO ab_permission_view (id, permission_id, view_menu_id)"
                      " VALUES (nextval('ab_permission_view_id_seq'), :p, :v) RETURNING id", p=perm, v=view)
        self.sql("INSERT INTO ab_permission_view_role (id, permission_view_id, role_id)"
                 " VALUES (nextval('ab_permission_view_role_id_seq'), :pv, :r)", pv=pv, r=role)
        group = self.sql("INSERT INTO ab_group (id, name) VALUES (nextval('ab_group_id_seq'), :n) RETURNING id",
                         n=_rand("group-"))
        self.sql("INSERT INTO ab_group_role (id, group_id, role_id)"
                 " VALUES (nextval('ab_group_role_id_seq'), :g, :r)", g=group, r=role)

        self.assertEqual(self.erase(tenant)[0], 1)
        self.assert_erased(uid)
        self.assertIsNone(self.sql("SELECT id FROM ab_role WHERE id = :r", r=role))
        for table in ("dashboard_roles", "ab_permission_view_role", "ab_group_role"):
            with self.subTest(table=table):
                self.assertEqual(self.sql(f"SELECT count(*) FROM {table} WHERE role_id = :r", r=role), 0)
        # Only the links go: the dashboard, permission and group themselves stay.
        self.assertIsNotNone(self.sql("SELECT id FROM dashboards WHERE id = :d", d=dash))
        self.assertIsNotNone(self.sql("SELECT id FROM ab_permission_view WHERE id = :p", p=pv))
        self.assertIsNotNone(self.sql("SELECT id FROM ab_group WHERE id = :g", g=group))

    # ── a reference to a role that would block its delete ───────────────────────
    ROLE_REFERENCES = (
        "SELECT c.conrelid::regclass::text, c.confdeltype FROM pg_constraint c"
        " WHERE c.contype = 'f' AND c.confrelid = 'ab_role'::regclass"
    )
    # Cleared by the erase before it deletes the role (see erase_superset_data).
    ROLE_LINKS_CLEARED_FIRST = {"rls_filter_roles"}

    def blocking_role_references(self, conn):
        from sqlalchemy import text

        # 'c' (cascade), 'n' (set null) and 'd' (set default) let the delete
        # through; 'a' (no action) and 'r' (restrict) refuse it.
        return sorted(
            table for table, on_delete in conn.execute(text(self.ROLE_REFERENCES))
            if on_delete in ("a", "r") and table not in self.ROLE_LINKS_CLEARED_FIRST
        )

    def test_no_reference_to_a_role_can_block_its_delete(self):
        with self.engine.connect() as conn:
            self.assertEqual(self.blocking_role_references(conn), [],
                             "Superset has a reference to ab_role that would block the erase's role delete")

    def test_a_new_blocking_reference_to_a_role_is_caught(self):
        from sqlalchemy import text

        with self.engine.connect() as conn:
            trans = conn.begin()
            try:
                conn.execute(text("CREATE TABLE erasure_role_guard_probe (role_id integer REFERENCES ab_role(id))"))
                self.assertEqual(self.blocking_role_references(conn), ["erasure_role_guard_probe"])
            finally:
                trans.rollback()

    # ── R5: safe to repeat, bounded per call ────────────────────────────────────
    def test_a_second_run_matches_nobody(self):
        tenant, (subject,) = self.tenant_and_subjects()
        self.user([f"owsub:{subject}", f"tenant:{tenant}"])
        self.erase(tenant, subject)
        self.assertEqual(self.erase(tenant, subject)[:2], (0, 0))

    def test_work_is_bounded_and_every_call_makes_progress(self):
        tenant, (subject,) = self.tenant_and_subjects()
        uid = self.user([f"owsub:{subject}", f"tenant:{tenant}"])
        first = self.config.erase_superset_data(self.engine, tenant, subject, budget_seconds=0, batch=1)
        self.assertTrue(first["more"])
        self.assertTrue(self.account(uid)["active"], "anonymised before the erase finished")
        _, _, calls = self.erase(tenant, subject, budget_seconds=0, batch=1)
        self.assertGreater(calls, 1)
        self.assert_erased(uid)

    def test_data_written_between_calls_is_erased_too(self):
        # The user logs in again while the worker is between calls: their roles
        # are still in place (they go last), so the next call matches them again
        # and takes the new rows with the rest.
        tenant, (subject,) = self.tenant_and_subjects()
        uid = self.user([f"owsub:{subject}", f"tenant:{tenant}"])
        first = self.config.erase_superset_data(self.engine, tenant, subject, budget_seconds=0, batch=1)
        self.assertTrue(first["more"])
        self.sql("INSERT INTO logs (user_id, action, dttm) VALUES (:u, 'welcome', now())", u=uid)
        self.sql("INSERT INTO favstar (user_id, class_name, obj_id) VALUES (:u, 'Slice', 2)", u=uid)
        self.erase(tenant, subject, budget_seconds=0, batch=1)
        self.assert_erased(uid)

    # ── the cache flush ─────────────────────────────────────────────────────────
    @unittest.skipUnless(REDIS_URL, "needs SUPERSET_ERASURE_TEST_REDIS_URL")
    def test_the_flush_removes_only_superset_keys_in_its_own_db(self):
        import redis

        client = redis.Redis.from_url(REDIS_URL)
        client.flushdb()
        client.set("superset_a", 1)
        client.set("superset_data_b", 1)
        client.set("rq:job:c", 1)
        self.assertEqual(self.config.flush_superset_cache(REDIS_URL), 2)
        self.assertEqual(sorted(k.decode() for k in client.keys("*")), ["rq:job:c"])
        client.flushdb()

    # ── T19: every reference to a user is classified ────────────────────────────
    REFERENCES = (
        "SELECT c.conrelid::regclass::text, a.attname FROM pg_constraint c"
        " JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)"
        " WHERE c.contype = 'f' AND c.confrelid = 'ab_user'::regclass"
    )

    def unclassified(self, conn):
        from sqlalchemy import text

        return sorted(
            f"{table}.{column}"
            for table, column in conn.execute(text(self.REFERENCES))
            if f"{table}.{column}" not in self.config.ERASURE_HANDLED
            and column not in self.config.ERASURE_EXEMPT_COLUMNS
        )

    def test_every_reference_to_a_user_is_handled_or_exempt(self):
        with self.engine.connect() as conn:
            self.assertEqual(self.unclassified(conn), [],
                             "Superset has a reference to ab_user that erase neither handles nor exempts")

    def test_a_new_reference_to_a_user_is_caught(self):
        from sqlalchemy import text

        with self.engine.connect() as conn:
            trans = conn.begin()
            try:
                conn.execute(text("CREATE TABLE erasure_guard_probe (user_id integer REFERENCES ab_user(id))"))
                self.assertEqual(self.unclassified(conn), ["erasure_guard_probe.user_id"])
            finally:
                trans.rollback()


if __name__ == "__main__":
    unittest.main()
