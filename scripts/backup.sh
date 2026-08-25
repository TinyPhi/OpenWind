#!/usr/bin/env bash
# backup.sh — dumps the Postgres primary and copies the local-disk file storage
# directory to a timestamped local directory.
#
# Scope (see docs/local-setup.md "Backup & Disaster Recovery" for the full writeup):
#   - Postgres (tenant data, entities, workflows, automations) — critical, backed up here.
#   - Local-disk file storage (uploaded files, at FILES_STORAGE_PATH_HOST on the host —
#     see packages/files; MinIO was decommissioned in PR #340) — critical, backed up here.
#   - Redis / Novu's Mongo — NOT backed up. Both are treated as rebuildable/ephemeral
#     (queues, caches, sessions, transient notification state) — see the doc for why.
#
# RPO/RTO policy: 24h RPO (nightly run via the schedule documented in
# docs/local-setup.md). RTO is the measured restore duration recorded in that doc, not a
# pre-committed number — see issue #192.
#
# Usage (ad hoc, from repo root, with the stack up via `docker compose up -d`):
#   ./scripts/backup.sh
#
# Usage (cron-able — override the output directory, everything else has dev defaults):
#   BACKUP_DIR=/var/backups/openwind ./scripts/backup.sh
#
# Env vars (all optional):
#   BACKUP_DIR           Parent directory for timestamped backup runs (default: ./backups)
#   POSTGRES_SERVICE     docker compose service name for Postgres (default: postgres)
#   POSTGRES_BACKUP_USER Postgres role used for pg_dump (default: platform)
#   POSTGRES_BACKUP_DB   Database to dump (default: platform)
#   FILES_STORAGE_PATH_HOST  Host directory holding uploaded files — same variable
#                        docker-compose.yml bind-mounts into ow-backend/ow-worker
#                        (default: ../openwind-files, matching .env.example)

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

BACKUP_DIR="${BACKUP_DIR:-$(pwd)/backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="${BACKUP_DIR}/${TIMESTAMP}"

POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
POSTGRES_BACKUP_USER="${POSTGRES_BACKUP_USER:-platform}"
POSTGRES_BACKUP_DB="${POSTGRES_BACKUP_DB:-platform}"

FILES_STORAGE_PATH_HOST="${FILES_STORAGE_PATH_HOST:-../openwind-files}"

mkdir -p "$RUN_DIR"

echo "==> [1/2] Dumping Postgres database '${POSTGRES_BACKUP_DB}' (service: ${POSTGRES_SERVICE})..."
PG_DUMP_FILE="${RUN_DIR}/postgres-${POSTGRES_BACKUP_DB}.dump"
docker compose exec -T "$POSTGRES_SERVICE" \
  pg_dump -U "$POSTGRES_BACKUP_USER" -d "$POSTGRES_BACKUP_DB" --format=custom \
  > "$PG_DUMP_FILE"
echo "    -> ${PG_DUMP_FILE} ($(du -h "$PG_DUMP_FILE" | cut -f1))"

echo "==> [2/2] Copying file storage directory '${FILES_STORAGE_PATH_HOST}'..."
FILES_DIR="${RUN_DIR}/files"
if [ -d "$FILES_STORAGE_PATH_HOST" ]; then
  mkdir -p "$FILES_DIR"
  cp -a "${FILES_STORAGE_PATH_HOST}/." "$FILES_DIR/"
else
  echo "    (warning: ${FILES_STORAGE_PATH_HOST} does not exist yet — nothing uploaded, or path misconfigured. Creating empty directory.)"
  mkdir -p "$FILES_DIR"
fi
FILE_COUNT=$(find "$FILES_DIR" -type f | wc -l | tr -d ' ')
echo "    -> ${FILES_DIR} (${FILE_COUNT} file(s))"

echo "==> Backup complete: ${RUN_DIR}"
