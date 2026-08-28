# Backup / DR Runbook

> Fix the stale backup script, wire a real schedule, prove restore works — for ops running the platform's single shared Postgres + local-disk file storage.

status: approved
created: 2026-08-25
updated: 2026-08-25

---

## §G Goal

- `scripts/backup.sh` backs up both Postgres and the local-disk files directory
  without error against the current architecture.
- A recurring schedule actually runs it (not just documented as cron-able).
- One supervised restore has been performed and timed; the runbook states the
  measured duration as the current RTO baseline, not an aspirational number.
- `docs/local-setup.md`'s Backup & Disaster Recovery section reflects the 24h RPO
  policy, the real schedule, and the restore procedure someone unfamiliar with the
  incident could follow under pressure.

## §C Constraints

| constraint         | value                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack              | Postgres 16 (docker), local-disk file storage at `FILES_STORAGE_PATH_HOST` (bind-mounted, default `../openwind-files`) — MinIO is fully decommissioned (PR #340)      |
| RPO                | 24h — nightly backup is sufficient; no intra-day/PITR requirement at this stage                                                                                       |
| RTO                | no pre-committed number — measured from the first real test restore and documented as the current baseline                                                            |
| schedule mechanism | host-level cron or systemd timer — the docker compose stack runs on a server (per CLAUDE.md), not inside a container                                                  |
| out of scope       | point-in-time recovery (WAL shipping/`wal-g`/`barman`), offsite/off-host backup storage, per-tenant selective restore — all explicitly deferred, not silently dropped |
| off-limits         | `.github/workflows/*` (this is host cron, not CI)                                                                                                                     |

## §I Interfaces

- `scripts/backup.sh` — existing script, env-var driven (`BACKUP_DIR`, `POSTGRES_SERVICE`, `POSTGRES_BACKUP_USER`, `POSTGRES_BACKUP_DB`). MinIO-specific vars (`MINIO_MC_SERVICE`, `MINIO_BUCKET`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`) are removed; replaced with a files-directory path input.
- Output layout unchanged in spirit: `${BACKUP_DIR}/<UTC timestamp>/postgres-platform.dump` + `${BACKUP_DIR}/<UTC timestamp>/files/...` (renamed from `minio/platform-files/...`).
- `docs/local-setup.md` "Backup & Disaster Recovery" section — existing section, rewritten in place.

## §R Requirements

R1: `scripts/backup.sh` runs successfully against the current stack (no MinIO reference)
✓ script contains no reference to `minio-init`, `mc mirror`, or any MinIO env var
✓ running `./scripts/backup.sh` against a live `docker compose up -d` stack exits 0
✓ output directory contains both a non-empty `postgres-platform.dump` and a copy of every file present under the host's `FILES_STORAGE_PATH_HOST` directory at run time

R2: Backup runs on a recurring schedule without manual intervention
✓ a documented cron entry or systemd timer unit exists in `docs/local-setup.md` (or a checked-in timer unit file) that invokes `scripts/backup.sh` on a schedule meeting 24h RPO (e.g. nightly)
✓ the schedule mechanism is one a new operator could install by following the doc alone, without asking the original author

R3: A real restore has been performed and its duration recorded
✓ `docs/local-setup.md` states the actual wall-clock time of one supervised `pg_restore` + files-directory restore, performed against a non-production target
✓ the restore procedure documented is the exact commands run during that test — not a theoretical `pg_restore` invocation nobody has executed
✓ if the restore surfaced a gap (e.g. a step that wasn't obvious, a missing permission), it's called out explicitly rather than smoothed over

R4: RPO/RTO policy is stated as policy, not left implicit in a script comment
✓ `docs/local-setup.md` states "RPO: 24h" and "RTO: <measured duration>, established <date>" in plain language near the top of the Backup & Disaster Recovery section
✓ the doc states explicitly what's out of scope (PITR, offsite storage, per-tenant restore) so a reader doesn't assume more coverage than exists

## §V Invariants

- Backup tooling must never reference a storage backend the app no longer uses — a stale backup script is worse than no script, since it creates false confidence until the day it's needed and fails.
- Every backup-affecting architecture change (e.g. a future move off local-disk storage) must update `scripts/backup.sh` in the same PR — this is now the second time the backup script has drifted from `packages/files`' actual storage backend.
- RTO in the runbook must always be a measured number with a date, not an estimate — an unmeasured RTO gives false confidence during an actual incident.
- A backup script must never exit 0 for a state it cannot distinguish from silent data loss (e.g. an expected source path missing) — fail loudly instead. A backup script that always reports success regardless of what it actually captured is worse than no backup script at all.

## §T Tasks

| id  | task                                                                                                                                                                             | phase | status | depends |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | fix `scripts/backup.sh`: remove MinIO mirror step, add local-disk files directory backup (tar or rsync of `FILES_STORAGE_PATH_HOST`)                                             | 1     | done   | —       |
| T2  | add/update a test for `scripts/backup.sh` if a test harness pattern exists for shell scripts in this repo; otherwise document manual verification in the PR                      | 1     | done   | T1      |
| T3  | write a cron entry / systemd timer example wiring `backup.sh` to a 24h schedule                                                                                                  | 2     | done   | T1      |
| T4  | perform one supervised test restore (`pg_restore` + files-directory restore) against a non-prod target, time it                                                                  | 2     | done   | T1      |
| T5  | rewrite `docs/local-setup.md`'s Backup & Disaster Recovery section: RPO/RTO policy statement, schedule, exact restore procedure with measured timing, explicit out-of-scope list | 2     | done   | T3,T4   |

phase gate: all unit + integration tests pass before advancing to next phase (N/A for shell-script-only changes beyond manual verification — record this explicitly rather than silently skipping the gate)

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                                                                                         | root cause                                                                                                                                                                                                                                                                      | promoted to §V? |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| B1  | `scripts/backup.sh` fails today against the current stack                                                                                                                                           | script mirrors a MinIO bucket via the `minio-init` service, which PR #340 commented out of `docker-compose.yml` when file storage moved to local disk — backup tooling wasn't updated in that PR                                                                                | yes — see §V    |
| B2  | PR #482 review (F-01): `scripts/backup.sh`'s files-copy step silently exited 0 with an empty backup when `FILES_STORAGE_PATH_HOST` didn't exist — warned to stdout, created an empty dir, continued | else-branch treated a missing source directory as equivalent to a genuinely-empty one, when it's actually ambiguous (misconfigured path vs. fresh deploy) and — if misconfigured — every nightly backup would report success with zero files until an actual restore was needed | yes — see §V    |

---

_spec is source of truth — update as decisions are made_
