# Superset erasure runbook

What happens to a person's data in Superset when they are erased from OpenWind, how to see that it
finished, and what to do when it did not. Specified in
[superset-gdpr-erasure.md](../specs/superset-gdpr-erasure.md) (#728); the isolation design is
[ADR-019](../decisions/ADR-019-reporting-tenant-isolation.md).

## What it does

Superset keeps its own database: a person's saved queries, query history, activity log, name, email
and an active account. The platform cannot reach it, so Superset erases its own data behind
`POST /openwind/erasure/user` and `/tenant` (service account only).

| Event in OpenWind                             | What follows in Superset                                                                                                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An admin erases a user (`DELETE /users/:id`)  | A `superset-erasure` job erases that user's Superset data, and the result cache is flushed. Only for a member of the admin's own tenant; for anyone else only the cache is flushed.                         |
| A tenant is purged (after its deletion delay) | A `superset-erasure` job erases every Superset user of that tenant, and the result cache is flushed.                                                                                                        |
| `SUPERSET_DEPLOYMENT=off` (the default)       | Nothing: no Superset is expected (the user erase answers `disabled`, the tenant purge does not wait on Superset). Unless Superset itself reports Stage 2 on, which overrides it (below).                    |
| Deployment on, Superset Stage 2 off           | Only the result cache is flushed. Guests are not stored as Superset users, so there is nothing else to erase. Only when Superset has confirmed Stage 2 is off; otherwise the erase is `unverified` (below). |

**`SUPERSET_DEPLOYMENT`** (`off` default, or `on`) says whether this install runs Superset at all. Set it to
`on` on the API (`ow-backend`) and the worker (`ow-worker`) of every deployment that runs Superset: the
production compose file defaults it to `on` (the superset services are part of that stack), the dev
compose file defaults it to `off` and you set it in `.env` together with `--profile reporting`. With `off`
no other Superset variable is needed, nothing alerts, and no job fails. It replaces
`SUPERSET_ERASURE_ENABLED`, which is now ignored (the API and worker log a startup warning if it is
still set).

Stage 2 is on when `SUPERSET_OAUTH_CLIENT_ID` is set in Superset. With the deployment `on`, the API and
worker use their own copy of the id to tell Stage 2 (erase accounts) from Stage 1 (flush the cache), and
it is checked against Superset's (see "Enablement self-check"). The id is OAuth wiring: it no longer
decides whether erasure is enabled. An id set while the deployment is `off` logs a startup warning.

The job logs in to Superset as the service account, calls the endpoint until it reports it has
finished, and writes one audit row. If a call fails it retries: after 1, 2, 4, 8, 16 and 32 minutes,
then every hour, for 32 attempts (about 26 hours). Running it again is safe: a finished erasure
matches nobody.

## See that it finished

Who erased the person, and when, is the platform's own audit row (`deleted` on the user, or
`purge.completed` on the tenant). The Superset result is a second row with the same `tenant_id`,
`resource_type` and `resource_id`, written by the system:

| `action`                     | Meaning                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `superset_erasure.completed` | Superset's data was erased. `metadata` has counts only (below).                           |
| `superset_erasure.failed`    | Every retry was spent without finishing. An operator has to act (next section).           |
| neither                      | Still retrying, never queued (Stage 2 off, or the queue was down), or the worker is down. |

`completed` metadata: `matchedUsers` (accounts erased), `heldUsers` (see below), `deletedRows`,
`cacheKeysRemoved`, `calls` (calls Superset needed), `attempts` (attempts the job needed). No name,
email or SQL is stored.

**`heldUsers` above 0.** The person also has a Superset account that belongs only to another tenant
(they moved organisation). That account is not erased, because that would delete their records in the
other tenant. It is logged as a warning. Decide with the other tenant's admin whether to erase it
with `superset openwind-erase --tenant <that tenant> --subject <id>`.

## When it did not finish

The `SupersetErasureFailed` alert fires when an erasure did not complete, told apart by its `outcome` label:

- `failed`: a job spent its last retry (about 26 hours). The job log line says "superset erasure failed on its last
  attempt" and a `superset_erasure.failed` row exists.
- `not_queued`: the job could not be queued immediately when the API processed the deletion (e.g. Redis blip or
  API restart). For a tenant purge, the purge job fails and retries. For a user, the reconciliation worker sweep
  (`superset-erasure-reconcile`, every 5 minutes) sweeps `deleted` user audit rows lacking a `superset_erasure.completed`
  sibling and re-queues the erasure automatically.
- `unverified`: Superset's Stage 2 state could not be confirmed at erasure time. The reconciler retries the row once the
  self-check is green.

A persistent gap raises **`SupersetErasureUnreconciled`**: fires when any committed user erasure remains unreconciled
or uncompleted after 1 hour. Unlike the 1-hour `increase()` counter, this gauge alert remains active as long as personal data
remains in Superset without an audit completion record.

A third alert, `SupersetErasureJobFailedInQueue`, fires while any job is in the queue's failed state. A failed job is
removed by the `superset-erasure-reconcile` sweep (every 5 minutes) once it has been failed for 24 hours, so the alert
clears within about 5 minutes after that. A completed job, whose payload names the person just the same, is removed by
the same sweep one hour after it completed. BullMQ's own `removeOnFail.age` is **not** relied on: it trims old failed jobs
only at the moment another job in the same queue fails, so a failure that no later failure follows would keep its payload
(`{kind, tenantId, subject}`, which names the person) in Redis indefinitely. If the worker or the sweep is down, the job
stays until it is back. The alert also catches a job BullMQ failed because the worker died twice while running it: that job
has no `failed` audit row.

**The lasting record is the audit log, not Redis.** A failed job is gone from the queue after 24 hours, and the alert
resolves with it, so a "resolved" notice does not mean the person was erased. To find an erasure that never completed,
look in `admin_audit_log` for a `deleted` (user) or `purge.completed` (tenant) row with no `superset_erasure.completed`
sibling for the same tenant and subject: that gives the tenant and subject to run by hand as below. The reconcile sweep
re-queues **user** rows by itself; it does not yet cover **tenant** purge rows (that is #1182), so a stalled tenant
erasure has to be found this way until #1182 lands.

A terminal failure also leaves **no standing alert**: the job is gone after 24 hours and `SupersetErasureFailed` clears
after an hour. So check the audit log on a schedule that fits the 30-day target (weekly is enough), for erasures that
failed for good and were never completed:

```sql
SELECT f.tenant_id, f.resource_type, f.resource_id, f.created_at,
       d.metadata->>'userId' AS subject          -- the Zitadel subject, from the user's `deleted` row
FROM admin_audit_log f
LEFT JOIN admin_audit_log d
  ON d.tenant_id = f.tenant_id AND d.resource_type = 'user'
 AND d.resource_id = f.resource_id AND d.action = 'deleted'
WHERE f.action = 'superset_erasure.failed'
  AND (f.metadata->>'status' IS NULL OR f.metadata->>'status' <> 'unverified')  -- terminal, as the reconciler reads it
  AND f.created_at > now() - interval '30 days'
  AND NOT EXISTS (
    SELECT 1 FROM admin_audit_log c
    WHERE c.tenant_id = f.tenant_id
      AND c.resource_type = f.resource_type
      AND c.resource_id = f.resource_id
      AND c.action = 'superset_erasure.completed'
      AND c.created_at > f.created_at);
```

Run it through the platform's admin database access. Each row is a person (or a tenant, `resource_type = 'tenant'`) whose
Superset data may still be there: run the erase by hand, as in step 2 below. This query has not been run against a
production database; it follows the matching the reconciler uses (`superset-erasure-reconcile.ts`).

1. **Find the cause in the worker log** (`ow-worker`), the line before the final one. Usual causes:

   | Log says                                       | Cause and fix                                                                                                                                              |
   | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `fetch failed`, or a timeout                   | Superset is down or unreachable at `SUPERSET_INTERNAL_URL`. Start it.                                                                                      |
   | `SUPERSET_SERVICE_ACCOUNT_PASSWORD is not set` | The worker has no service account password. See "Production setup".                                                                                        |
   | `Superset login failed with 401`               | Wrong service account password in the worker.                                                                                                              |
   | `Superset erase call failed with 403`          | The service account has lost the `ReportingServiceAccount` role (`bootstrap.py` grants it).                                                                |
   | `Superset erase call failed with 400`          | CSRF or request problem: check the Superset version still matches the one in `docker/superset/Dockerfile`.                                                 |
   | an `insert into "admin_audit_log"` error       | Migration `0156_superset_erasure_audit_actions` is not applied. Apply migrations; the job keeps Superset's result and retries, so the counts are not lost. |

2. **Fix it, then run the erase by hand.** The failed job is not retried again, and the sweep removes it 24 hours
   after it failed. Erasing the same user again from OpenWind does **not** queue a new job: the first erase
   already removed them from the organisation, so the API answers "not found". Run it from a shell on
   the host that runs Superset:

   ```
   docker exec ow-superset superset openwind-erase --tenant <tenant-uuid> --subject <zitadel-user-id>
   docker exec ow-superset superset openwind-erase --tenant <tenant-uuid>      # a whole tenant
   ```

   It loops until finished and prints counts. It writes no audit row: only someone with shell access
   to the server can run it, and the server keeps its own access records. Use it only for a job that
   keeps failing, and note **who ran it and why** in the incident ticket.

3. **Check** that no Superset account still holds the person: their username is `erased-<id>` and
   `active` is false. Then close the ticket.

If personal data stayed in Superset longer than expected, treat it as a possible personal-data
incident and follow the [breach notification runbook](breach-notification.md).

## Enablement self-check

Superset decides whether Stage 2 is on from its own `SUPERSET_OAUTH_CLIENT_ID`; the API and the worker
decide from `SUPERSET_DEPLOYMENT` and theirs (#1137). A BullMQ repeatable job (queue
`superset-erasure-selfcheck`, fixed job id, so one run per interval however many worker replicas there
are, plus one at worker startup) asks Superset (`GET /openwind/erasure/status`), compares the answer with
the local setting, and runs a no-op erase for a synthetic tenant that matches nobody, which proves the
erase route, CSRF, role and database access work. It writes no audit row and touches no tenant data. The
result is kept in Redis, and the API and the tenant purge act on it.

Settings: `SUPERSET_SELFCHECK_INTERVAL_MINUTES` (default 15) and `SUPERSET_SELFCHECK_TTL_MINUTES`
(default 30, at least twice the interval). Changing the interval takes effect at the next worker start,
which removes the old repeat schedule.

| `openwind_superset_erasure_selfcheck_total{outcome}` | Meaning                                                                                            | What to do                                                                                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`                                                 | Superset and the worker agree, and the smoke erase worked.                                         | Nothing.                                                                                                                                           |
| `mismatch`                                           | They disagree on Stage 2 (the worker log says which way).                                          | Set `SUPERSET_DEPLOYMENT=on` and store `SUPERSET_OAUTH_CLIENT_ID` at every path in "Production setup" (or remove the id everywhere), then restart. |
| `smoke_failed`                                       | The status route or the smoke erase failed (404: old Superset image; 403: role; 400: CSRF).        | Same causes as the table under "When it did not finish".                                                                                           |
| `unreachable`                                        | No session could be opened: Superset is down, or the service account password is wrong.            | Start Superset, or fix `SUPERSET_SERVICE_ACCOUNT_PASSWORD` at the worker.                                                                          |
| `skipped`                                            | `SUPERSET_DEPLOYMENT=off` and Superset is unreachable or reports Stage 2 off: nothing is expected. | Nothing. This is the state of a deployment with no Superset.                                                                                       |

Alerts: `SupersetErasureConfigMismatch` fires when the gauge `openwind_superset_erasure_config_mismatch`
has been 1 for 10 minutes. `SupersetErasureSelfcheckFailing` fires when checks ran for an hour and none
was `ok`. With `SUPERSET_DEPLOYMENT=off` neither alert can fire unless Superset itself reports Stage 2 on
(then the first does).

**What an erase says while this is not `ok`.**

- Superset reports Stage 2 on, but this service has `SUPERSET_DEPLOYMENT=off` or no id: the erase runs in
  full anyway (the job is queued, or the tenant purge queues it), the cache flush runs, and an error is
  logged. The mismatch alert tells you to fix the setting.
- The deployment is `on`, this service says Stage 2 is off and Superset has not confirmed that (no fresh
  result, or Superset unreachable): the user erase answers `superset.status: "unverified"` with HTTP 200, and the
  Users page shows a warning, not a success. The platform data is erased, but it is **not known** whether
  Superset holds an account. The API counts it as `openwind_superset_erasure_total{outcome="unverified"}`
  (alert `SupersetErasureFailed`). The API also writes a `superset_erasure.failed` audit row on the user
  (as the system, `metadata`: `kind: "user"`, `status: "unverified"`, `userId`), which is what the
  reconciler (#1138) automatically sweeps and retries once the self-check is green.
- A tenant purge in the same state fails with "the Superset erasure could not be verified" and retries
  (3 attempts). The database purge has already committed, so a retry only repeats the cleanup outside the
  database. Once the self-check is `ok`, add the purge job again (the "already purged" path queues the
  Superset erasure).
- With `SUPERSET_DEPLOYMENT=off` the safety net only works while the worker can ask Superset: it needs
  `SUPERSET_SERVICE_ACCOUNT_PASSWORD` and a reachable `SUPERSET_INTERNAL_URL`. An install that runs Superset
  with Stage 2 on but has neither the flag nor the password never learns that Superset holds accounts (the
  check says `skipped`), so set `SUPERSET_DEPLOYMENT=on` there. If Superset last reported Stage 2 on and
  then cannot be asked, the check keeps that answer (as `unreachable`) instead of falling back to `skipped`.
  The result in Redis is trusted like the queue itself: anyone who can write that Redis can forge it.
- A deployment with no Superset: leave `SUPERSET_DEPLOYMENT` at `off` (the default); nothing else is
  needed. If it is `on` with no Superset, the worker reports `unreachable`, user erases answer
  `unverified` and tenant purges fail, on purpose.

To see the last result without logs: the Redis key `ops:superset-erasure:selfcheck` (JSON, no personal
data). It has no value when the worker has not checked within `SUPERSET_SELFCHECK_TTL_MINUTES`.

## When the sign-in was not removed

`DELETE /users/:userId` answers 502 `SIGN_IN_NOT_REMOVED` (the admin sees "Erase incomplete") when the
person's data was erased but Zitadel refused or could not be reached for the sign-in delete. The person
can still sign in until it is removed. Erase them again from the Users page once Zitadel is healthy: they
are still one of the organisation's Zitadel users, the data erase finds nothing left, and the delete is
retried. The API log line is "GDPR erasure: data erased but the Zitadel sign-in was not removed".

## Production setup

Stage 2 is on in Superset when it has `SUPERSET_OAUTH_CLIENT_ID`. `SUPERSET_DEPLOYMENT` is a plain
setting, not a secret: `docker-compose.prod.yml` sets it to `on` for `ow-backend` and `ow-worker`
(override it in `.env` only for an install without Superset). With the deployment `on`, the API and the
worker decide for themselves, from their own environment, whether Stage 2 is on. Each service reads its own
OpenBao path, so enabling Stage 2 is one checklist across four services:

| Service         | OpenBao path                   | Store when Stage 2 is enabled                              |
| --------------- | ------------------------------ | ---------------------------------------------------------- |
| `superset`      | `openwind/<env>/superset`      | `SUPERSET_OAUTH_CLIENT_ID`, `SUPERSET_OAUTH_CLIENT_SECRET` |
| `superset-init` | `openwind/<env>/superset-init` | `SUPERSET_OAUTH_CLIENT_ID`, `SUPERSET_OAUTH_CLIENT_SECRET` |
| `ow-backend`    | `openwind/<env>/backend`       | `SUPERSET_OAUTH_CLIENT_ID` (the same value)                |
| `ow-worker`     | `openwind/<env>/worker`        | `SUPERSET_OAUTH_CLIENT_ID` (the same value)                |

`SUPERSET_SERVICE_ACCOUNT_PASSWORD` is required at `backend`, `worker` and `superset-init` whether
Stage 2 is on or not (it is in their `BAO_REQUIRED_KEYS`), so a missing one stops startup instead of
failing erasure jobs for about 26 hours. Use the same value at all three. `SUPERSET_INTERNAL_URL` and
`SUPERSET_SERVICE_ACCOUNT_USER` are set in compose for both `ow-backend` and `ow-worker`.

`SUPERSET_OAUTH_CLIENT_ID` is deliberately not in any `BAO_REQUIRED_KEYS`: it is what turns Stage 2
on, so requiring it would force Stage 2 on in every deployment. With OpenBao (ADR-023) a key must be
in OpenBao **or** in compose, never both.

**Enable it at all four services in the same change.** Each service decides for itself from its own
environment, so a missed path is a real risk. The worker now checks this for you: see "Enablement
self-check" below. If Superset has the client id but `ow-backend` or `ow-worker` does not, the
self-check reports a mismatch and the API and the tenant purge erase in Superset anyway (they follow
what Superset reports), but fix the missing key: the alert stays on until you do.

**Upgrading an existing deployment (#1137).** Existing deployments that run Superset must have
`SUPERSET_DEPLOYMENT=on` on `ow-backend` and `ow-worker` (the production compose file does this by default;
for the dev compose file set it in `.env`). Anything that set `SUPERSET_ERASURE_ENABLED` can drop it. Left
unset on a dev-compose install with Superset, the flag is `off`, and the worker's self-check then reports
`mismatch` if Superset has Stage 2 on (the safety net still erases in full).

Add `SUPERSET_SERVICE_ACCOUNT_PASSWORD` to
`openwind/<env>/worker` **before** you deploy this compose file. `ow-worker` now requires it and
exits 78 at startup if it is missing or empty, and the worker also runs the outbox, SLA, notification
and schedule jobs, so a missing key stops all of them. It is required even when reporting is off.

Also recommended: do not route `/openwind/erasure/*` through the public proxy. Only the worker calls
it, inside the docker network. The endpoints already refuse every caller except the service account
(role checked, CSRF required), so this is a second layer.

## Enumeration of user-removal paths (#1140, ADR-019 criterion 16)

Every path where a user is removed or their account is deleted, whether it runs the Superset erasure, and if not why it
cannot leave a Superset account behind. Each path cites the code it was read from. A new caller of `deleteUser`,
`deleteOrg`, or a delete of `tenant_users` fails `apps/worker/src/superset-erasure-removal-paths.test.ts`. That test is a
best-effort tripwire, not a proof: it fails until its expected file set is edited, which is the prompt to update this list.
It matches the identifiers (an aliased import, a method call and a re-export count) and does not track a new wrapper
function in an already-listed file.

1. **Per-user GDPR erasure (`DELETE /users/:userId`)**, `apps/api/src/routes/platform/users.ts`.
   - Erases the person's data across the tenant (`eraseUserFromTenant`, which deletes the `tenant_users` row at
     `apps/api/src/services/user-erasure.ts:713`), removes their Zitadel sign-in (`deleteUser`, `users.ts:239`) and calls
     `eraseUserInSuperset({ tenantId, subject, wasMember })` (`users.ts:266`).
   - For a **member** of the tenant, `eraseUserInSuperset` queues a `kind: "user"` job
     (`apps/api/src/lib/superset-erasure-queue.ts:212`). If queueing fails, the reconcile sweep re-queues the `deleted`
     audit row within 5 minutes.
   - For a **non-member** it queues nothing and answers `not_member` (`superset-erasure-queue.ts:200-211`): an admin must not
     reach a person outside their organisation through Superset. This is the accepted "held account" case; only the cache
     flush runs.
2. **Tenant purge (`tenant-purge` worker)**, `apps/worker/src/tenant-purge.ts`.
   - Purges the tenant's tables (the `tenant_users` delete is at `:514`) and enqueues `kind: "tenant"` erasure (`:258`).
     `/openwind/erasure/tenant` deletes every Superset account bound to the tenant's role (`tenant:<uuid>`) and flushes the
     result cache.
3. **Tenant deletion (`DELETE /admin/tenants/:id`)**, `apps/api/src/routes/admin/index.ts:43`.
   - Schedules deletion (`scheduleTenantDeletion`, `apps/api/src/lib/tenant-lifecycle.ts:319-359`) and a delayed purge job.
     **Superset accounts stay until the purge runs**, by default 30 days later (`DEFAULT_DELETION_DELAY_DAYS`,
     `tenant-lifecycle.ts:88`); the purge then removes them as in path 2. The window is deliberate.
4. **Sandbox delete (`sandbox-delete` worker)**, `apps/worker/src/sandbox-delete-worker.ts`.
   - Deletes the sandbox's Zitadel organisation (`deleteOrg`, `:126`), which removes every seeded account, and enqueues an
     immediate `tenant-purge` job, so the tenant erasure of path 2 runs.
5. **Sandbox provisioning rollback**, `apps/worker/src/sandbox-provisioning-worker.ts:586`.
   - On a failed provisioning job, `deleteOrg` removes the half-created organisation and every account seeded into it.
     No Superset account can exist for them: Superset creates an account at first sign-in, and the credentials were never
     handed over (handover is only offered for a provisioning job that finished). This follows from the code; it was not
     checked on a running instance.
6. **Sandbox reset (`sandbox-reset` worker)**, `apps/worker/src/sandbox-reset-worker.ts`.
   - Wipes business records and reseeds demo tickets. **Removes no user**: accounts, teams, `tenant_users` and org-directory
     employees are kept so prospect sign-in is undisturbed, so no account is left behind.
7. **Sandbox handover (`GET /platform-admin/sandboxes/:jobId/handover`)**,
   `apps/api/src/routes/platform-admin/sandboxes.ts`. Read-only retrieval of the seeded credentials within 7 days; creates,
   changes and removes no account.
8. **Org-directory sync (`syncOrgDirectory`)**, `packages/org-directory/src/sync.ts`.
   - The importer builds the org chart from **Zitadel** metadata (`packages/org-directory/src/zitadel-importer.ts`). When a
     person drops out of it, sync removes them from the `org_employees` tree. It deletes no `tenant_users` row and no
     Zitadel login, so no account is removed.
9. **Platform admin accounts**. **NOT YET CONFIRMED.** `PLATFORM_ORG_ID` is a `tenants.id` compared with the caller's
   `auth.tenantId` (`apps/api/src/lib/platform-operator.ts:12`), not a Zitadel organisation. A platform admin gets a
   Superset account, and a `tenant:<uuid>` role, only if that platform tenant maps to a Zitadel organisation
   (`tenant_for_org`, migration 0114) and they sign in to Superset. No code path removes a platform admin's Superset account
   when the person is removed. To check whether any exist: list the Superset users and compare them with the platform admins.
10. **Removal outside OpenWind (not covered).** A user deleted or deactivated directly in the Zitadel console or management
    API is removed from the sign-in but nothing in OpenWind reacts to it (no handler for a Zitadel user-removal event was
    found), so their Superset account and queries stay until someone runs `superset openwind-erase` for them (see "When it
    did not finish", step 2). Treat a removal done outside OpenWind as needing that step.

## Process logs and export files (#1140, ADR-019 items 2–3)

Status key: **From code and config** means read from this repository. **NOT YET CONFIRMED** means no check on a running
instance has been made; the commands to make it are given, for the gate owner to run and record here with the date and
the Superset image digest.

### Process logs

What Superset writes to its container stdout and stderr, **from code and config**:

- **Gunicorn access log.** Method, path **without the query string**, status and duration in microseconds. Production
  runs upstream `run-server.sh`, which passes only `--access-logfile`; both compose files set
  `GUNICORN_CMD_ARGS="--access-logformat '%(m)s %(U)s %(s)s %(D)s'"`. The default format would write the whole request
  line, and Superset's GET endpoints carry filter values and ad-hoc SQL in `q=` and `form_data=`. The client address and
  the referer are not logged. Pinned by `docker/superset/test_log_hygiene.py`.
- **Erasure endpoints** log the tenant id and `yes` or `whole-tenant` for the subject, never the subject id, and a failure
  logs the exception **type** only (`log_error_type`): the exception text carries the bound `owsub:<subject>` parameter.
  Every failure log in `superset_config.py` is type-only, and a test forbids `logger.exception` and `exc_info` there.
- **Flask-AppBuilder's own sign-in and user-management errors** log values: the whole `userinfo` dict, the username, an
  email address and the text of a failed `add_user`, at ERROR, which `SILENCE_FAB` does not hide. A logging filter on
  `flask_appbuilder.security.manager` and `flask_appbuilder.security.sqla.manager` keeps each message and replaces its values
  with `[REDACTED]`, and drops any traceback (`_ScrubFabSecurityLogs`, pinned by `test_log_hygiene.py` on synthetic records of
  the FAB 5.0.2 messages). **NOT YET CONFIRMED on a running instance**: that Superset's logging setup leaves the filter in
  place. Cause a sign-in failure for a throwaway account (for example two accounts with one email) and check `docker logs`
  for `[REDACTED]` and for the absence of the email.
- **Sign-in warnings** log the opaque Zitadel subject id, never `preferred_username` or an email address (a Stage 2
  username is the `preferred_username`, usually a login name or an email). The per-query "no tenant" line logs no identity.
  **Residual personal data:** the subject id is pseudonymous, not anonymous, and these lines are not touched by an erasure.
  They age out only with the log rotation below.
- **A failed audit write** logs the action and the exception type only (`log_audit_write_failure`). A SQLAlchemy error
  message includes the bound parameters, which here are the audit row's JSON, whose `sql` field is the user's SQL Lab query,
  and nothing in this deployment sets `hide_parameters`.
- **Verbatim SQL** is not logged by Superset's engine (`echo` is off). SQL Lab query audit rows go to `admin_audit_log`
  through `PlatformAuditEventLogger`, with literals and comments redacted (#1139).
- **Not controlled here:** messages and tracebacks Superset, Flask, SQLAlchemy and gunicorn write from their own code. No
  log level is set in this repository, so the library default applies.

**Retention is bounded by size, not by age.** The `superset` service sets Docker's `json-file` driver with
`max-size: 10m` and `max-file: 5` (`docker-compose.yml`, inherited by `docker-compose.prod.yml`), so the container logs hold
at most about 50 MB. On a busy instance that is days of logs; on a quiet one it can be months. State the retention you
need to a regulator in those terms, or move the logs to a store with an age limit.

**NOT YET CONFIRMED on a running instance** (commands for the gate owner):

```
docker inspect ow-superset --format '{{json .HostConfig.LogConfig}}'          # expect json-file, max-size 10m, max-file 5
docker exec ow-superset env | grep GUNICORN_CMD_ARGS                          # expect the --access-logformat above
# run one SQL Lab query containing a literal email and one CSV export as a test user, then:
docker logs ow-superset --since 15m | grep -E "[?]q=|form_data|@"             # expect no query string and no email
```

### Export files

**From code and config:** CSV exports from SQL Lab (`SqlLabRestApi.export_streaming_csv`) and chart CSV downloads are
streamed in the HTTP response. No Celery worker and no `RESULTS_BACKEND` is configured in `superset_config.py` or the
compose files, and the `superset` service mounts no export volume (only `superset_config.py`, read-only).

**NOT YET CONFIRMED on a running instance:**

```
docker inspect ow-superset --format '{{json .Mounts}}'                        # expect only superset_config.py
# after a test export:
docker exec ow-superset find / -xdev -newer /app/pythonpath/superset_config.py \( -name '*.csv' -o -name '*.xlsx' \) 2>/dev/null
```

## What it does not cover

- **Backups.** Superset's database is deliberately not backed up (spec D5), so no backup holds an
  erased person's Superset data. What a restore loses is in [local setup](../local-setup.md).
- **A tenant purge** finds Superset accounts by the tenant's role. An account with no tenant role is
  found only by a per-user erase, which the platform runs for each user it erases.
- **The result cache** is flushed for every tenant, not selectively: Superset's cache keys are not
  namespaced. Dashboards re-query once.
- **Retention** of Superset query history and audit records for people who are not erased is a
  separate decision (spec D4, open with Legal / DPO).
