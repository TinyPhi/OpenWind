#!/usr/bin/env bash
# backup.sh — dumps the Postgres primary and mirrors the MinIO file bucket to a
# timestamped local directory.
#
# Scope (see docs/local-setup.md "Backup & Disaster Recovery" for the full writeup):
#   - Postgres (tenant data, entities, workflows, automations) — critical, backed up here.
#   - MinIO (`platform-files` bucket — uploaded files) — critical, backed up here.
#   - Redis / Novu's Mongo — NOT backed up. Both are treated as rebuildable/ephemeral
#     (queues, caches, sessions, transient notification state) — see the doc for why.
#
# NOT decided by this script: RPO/RTO targets and a production cron schedule are a
# maintainer/policy decision (tracked in issue #192) — this script is the mechanical
# building block for whatever schedule gets picked, not the schedule itself.
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
#   MINIO_MC_SERVICE     docker compose service whose image/network to reuse for `mc`
#                        (default: minio-init — already pinned to minio/mc, see docker-compose.yml)
#   MINIO_BUCKET         MinIO bucket to mirror (default: platform-files)
#   MINIO_ACCESS_KEY     MinIO access key (default: dev value from docker-compose.yml)
#   MINIO_SECRET_KEY     MinIO secret key (default: dev value from docker-compose.yml)

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

BACKUP_DIR="${BACKUP_DIR:-$(pwd)/backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="${BACKUP_DIR}/${TIMESTAMP}"

POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
POSTGRES_BACKUP_USER="${POSTGRES_BACKUP_USER:-platform}"
POSTGRES_BACKUP_DB="${POSTGRES_BACKUP_DB:-platform}"

MINIO_MC_SERVICE="${MINIO_MC_SERVICE:-minio-init}"
MINIO_BUCKET="${MINIO_BUCKET:-platform-files}"
MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-platform_access_key}"
MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-platform_secret_key_dev_only}"

mkdir -p "$RUN_DIR"

echo "==> [1/2] Dumping Postgres database '${POSTGRES_BACKUP_DB}' (service: ${POSTGRES_SERVICE})..."
PG_DUMP_FILE="${RUN_DIR}/postgres-${POSTGRES_BACKUP_DB}.dump"
docker compose exec -T "$POSTGRES_SERVICE" \
  pg_dump -U "$POSTGRES_BACKUP_USER" -d "$POSTGRES_BACKUP_DB" --format=custom \
  > "$PG_DUMP_FILE"
echo "    -> ${PG_DUMP_FILE} ($(du -h "$PG_DUMP_FILE" | cut -f1))"

echo "==> [2/2] Mirroring MinIO bucket '${MINIO_BUCKET}' (via ${MINIO_MC_SERVICE} image)..."
MINIO_DIR="${RUN_DIR}/minio"
mkdir -p "${MINIO_DIR}/${MINIO_BUCKET}"
docker compose run --rm --no-deps \
  -v "${MINIO_DIR}:/backup" \
  --entrypoint /bin/sh \
  "$MINIO_MC_SERVICE" -c "
    mc alias set local http://minio:9000 '${MINIO_ACCESS_KEY}' '${MINIO_SECRET_KEY}' >/dev/null &&
    mc mirror --overwrite --quiet local/${MINIO_BUCKET} /backup/${MINIO_BUCKET}
  "
FILE_COUNT=$(find "${MINIO_DIR}/${MINIO_BUCKET}" -type f | wc -l | tr -d ' ')
echo "    -> ${MINIO_DIR}/${MINIO_BUCKET} (${FILE_COUNT} file(s))"

echo "==> Backup complete: ${RUN_DIR}"
