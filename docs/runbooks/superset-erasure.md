# Superset erasure runbook

What happens to a person's data in Superset when they are erased from OpenWind, how to see that it
finished, and what to do when it did not. Specified in
[superset-gdpr-erasure.md](../specs/superset-gdpr-erasure.md) (#728); the isolation design is
[ADR-019](../decisions/ADR-019-reporting-tenant-isolation.md).

## What it does

Superset keeps its own database: a person's saved queries, query history, activity log, name, email
and an active account. The platform cannot reach it, so Superset erases its own data behind
`POST /openwind/erasure/user` and `/tenant` (service account only).

| Event in OpenWind                             | What follows in Superset                                                                                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An admin erases a user (`DELETE /users/:id`)  | A `superset-erasure` job erases that user's Superset data, and the result cache is flushed. Only for a member of the admin's own tenant; for anyone else only the cache is flushed. |
| A tenant is purged (after its deletion delay) | A `superset-erasure` job erases every Superset user of that tenant, and the result cache is flushed.                                                                                |
| Superset Stage 2 is off                       | Only the result cache is flushed. Guests are not stored as Superset users, so there is nothing else to erase.                                                                       |

Stage 2 is on when `SUPERSET_OAUTH_CLIENT_ID` is set. With Stage 2 on, `SUPERSET_ERASURE_ENABLED=false`
cannot turn the erasure off (the worker logs a warning). With Stage 2 off it decides whether the cache
flush runs at all: set to `false`, an erasure or purge flushes nothing and logs a warning ("Superset
erasure is turned off").

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

The `SupersetErasureFailed` alert fires in two cases, told apart by its `outcome` label:

- `failed`: a job spent its last retry. The job log line says "superset erasure failed on its last
  attempt" and a `superset_erasure.failed` row exists.
- `not_queued`: the job could not even be queued (Redis was down at that moment). The log line says
  "superset erasure could not be queued"; there is no job and no audit row. For a tenant purge, the
  purge job fails and its own retry queues the erasure again. For a user, nothing retries it: run
  the erase by hand as below.
  A second
  alert, `SupersetErasureJobFailedInQueue`, fires while any job is in the queue's failed state, which
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

## When the sign-in was not removed

`DELETE /users/:userId` answers 502 `SIGN_IN_NOT_REMOVED` (the admin sees "Erase incomplete") when the
person's data was erased but Zitadel refused or could not be reached for the sign-in delete. The person
can still sign in until it is removed. Erase them again from the Users page once Zitadel is healthy: they
are still one of the organisation's Zitadel users, the data erase finds nothing left, and the delete is
retried. The API log line is "GDPR erasure: data erased but the Zitadel sign-in was not removed".

## Production setup

The API and the worker have to know that Stage 2 is on, and the worker needs the service account
password. They read these from their own environment, not from Superset's:

| Setting                                                  | Where                                                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `SUPERSET_OAUTH_CLIENT_ID`                               | `ow-backend` and `ow-worker`: the same value Superset has. Unset means Stage 2 is off there. |
| `SUPERSET_INTERNAL_URL`, `SUPERSET_SERVICE_ACCOUNT_USER` | `ow-worker`: set in compose, same as `ow-backend`.                                           |
| `SUPERSET_SERVICE_ACCOUNT_PASSWORD`                      | `ow-worker`: the same password `ow-backend` already has.                                     |

With OpenBao (ADR-023) a key must be in OpenBao **or** in compose, never both. Store
`SUPERSET_OAUTH_CLIENT_ID` and `SUPERSET_SERVICE_ACCOUNT_PASSWORD` at the worker's path
(`openwind/<env>/worker`), and `SUPERSET_OAUTH_CLIENT_ID` at the backend's path, when Stage 2 is
enabled. Do not add them to `BAO_REQUIRED_KEYS` of a deployment that has Stage 2 off. If Stage 2 is on
in Superset but `ow-backend` and `ow-worker` do not have the client id, they treat it as off: only the
cache is flushed and **no Superset account is erased**.

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
