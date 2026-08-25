# Implementation Plan: Backup / DR Runbook

**Spec:** docs/specs/backup-dr-runbook.md
**Generated:** 2026-08-25
**Status:** done

---

## Phase 1 — Fix the backup script

**Goal:** `scripts/backup.sh` runs successfully against the current architecture (local-disk files, no MinIO).
**Gate:** running the script against a live `docker compose up -d` stack exits 0 and produces a non-empty Postgres dump + a files-directory copy → then Phase 2

| task                                                                                                                                                                     | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------ |
| T1: remove MinIO mirror step from `scripts/backup.sh`; add a step that copies/tars the host's `FILES_STORAGE_PATH_HOST` directory into the backup run directory          | R1          | done   |
| T2: manually verify by running `./scripts/backup.sh` against the live stack; record output in PROGRESS.md (no existing shell-script test harness in this repo to extend) | R1          | done   |

---

## Phase 2 — Schedule, restore proof, and docs

**Goal:** the backup runs unattended on a schedule, one real restore has been timed, and the runbook reflects both.
**Gate:** §R acceptance criteria met — Phase 1 gate still green

| task                                                                                                                                                                                                                                       | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------ |
| T3: write a cron entry / systemd timer example (as a doc snippet, and a checked-in `.timer`/`.service` unit file if that fits the repo's existing ops-file conventions) wiring `backup.sh` to a nightly schedule                           | R2          | done   |
| T4: perform one supervised restore (`pg_restore` into a scratch DB/container + files-directory restore) against a non-prod target; time it wall-clock                                                                                      | R3          | done   |
| T5: rewrite `docs/local-setup.md`'s Backup & Disaster Recovery section — state RPO=24h/RTO=<measured>, the schedule, the exact restore commands used in T4, and the explicit out-of-scope list (PITR, offsite storage, per-tenant restore) | R3, R4      | done   |

---

## Kick-Off Prompt

Read docs/specs/backup-dr-runbook.md and docs/specs/backup-dr-runbook-tasks.md.

Implement Phase 1 tasks only (T1, T2).

Rules:

- Do not begin Phase 2 until Phase 1's gate is green (script runs clean against the live stack).
- After each task, verify and confirm before continuing.
- If a decision isn't covered by the spec, stop and ask — do not assume.
- If something fails, log it via `/spec amend §B` before fixing.
- If a bug class could recur, promote it to `/spec amend §V`.
