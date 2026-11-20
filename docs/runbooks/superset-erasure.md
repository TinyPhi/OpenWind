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

A third alert, `SupersetErasureJobFailedInQueue`, fires while any job is in the queue's failed state, which
lasts 7 days or until the job is removed. It also catches a job BullMQ failed because the worker died
twice while running it: that job has no `failed` audit row, so look for it in the queue
(`bull:superset-erasure:*` in Redis) and run the erase by hand as below.

1. **Find the cause in the worker log** (`ow-worker`), the line before the final one. Usual causes:

   | Log says                                       | Cause and fix                                                                                                                                              |
   | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `fetch failed`, or a timeout                   | Superset is down or unreachable at `SUPERSET_INTERNAL_URL`. Start it.                                                                                      |
   | `SUPERSET_SERVICE_ACCOUNT_PASSWORD is not set` | The worker has no service account password. See "Production setup".                                                                                        |
   | `Superset login failed with 401`               | Wrong service account password in the worker.                                                                                                              |
   | `Superset erase call failed with 403`          | The service account has lost the `ReportingServiceAccount` role (`bootstrap.py` grants it).                                                                |
   | `Superset erase call failed with 400`          | CSRF or request problem: check the Superset version still matches the one in `docker/superset/Dockerfile`.                                                 |
   | an `insert into "admin_audit_log"` error       | Migration `0156_superset_erasure_audit_actions` is not applied. Apply migrations; the job keeps Superset's result and retries, so the counts are not lost. |

2. **Fix it, then run the erase by hand.** The failed job is kept for 7 days but is not retried
   again. Erasing the same user again from OpenWind does **not** queue a new job: the first erase
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

## What it does not cover

- **Backups.** Superset's database is deliberately not backed up (spec D5), so no backup holds an
  erased person's Superset data. What a restore loses is in [local setup](../local-setup.md).
- **A tenant purge** finds Superset accounts by the tenant's role. An account with no tenant role is
  found only by a per-user erase, which the platform runs for each user it erases.
- **The result cache** is flushed for every tenant, not selectively: Superset's cache keys are not
  namespaced. Dashboards re-query once.
- **Retention** of Superset query history and audit records for people who are not erased is a
  separate decision (spec D4, open with Legal / DPO).
