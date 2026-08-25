#!/usr/bin/env bash
# inject-outbox-backlog.sh — inserts synthetic, easily-identifiable backlog rows
# into outbox_events, to simulate worker-poller load (outbox-poller.ts,
# automation-worker.ts, etc.) running concurrently with API traffic during a
# pool-ceiling load test (issue #296). ow-worker and ow-backend share the same
# PgBouncer pool budget — see docs/specs/pool-load-test-tooling.md §G.
#
# Usage (from repo root, with the stack up via `docker compose up -d`):
#   ./scripts/load-test/inject-outbox-backlog.sh [count]     # default: 5000
#
# Cleanup (removes exactly the rows this script inserted, nothing else):
#   ./scripts/load-test/inject-outbox-backlog.sh --cleanup
#
# This is a standalone ops/test-data script, not application code — raw SQL
# via psql is appropriate here the same way scripts/backup.sh uses pg_dump
# directly (see .claude/rules/db-conventions.md's "no raw SQL in application
# code" rule, which scopes to packages/db and apps/*, not one-off ops tooling).

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
POSTGRES_USER="${POSTGRES_BACKUP_USER:-platform}"
POSTGRES_DB="${POSTGRES_BACKUP_DB:-platform}"

# Same demo tenant packages/db/src/seed.ts creates — see that file if this
# tenant doesn't exist in your stack yet (run `pnpm db:seed` first).
DEMO_TENANT_ID="00000000-0000-0000-0000-000000000001"
EVENT_TYPE="loadtest.synthetic_backlog"

if [ "${1:-}" = "--cleanup" ]; then
  echo "==> Removing synthetic backlog rows (event_type = '${EVENT_TYPE}')..."
  docker compose exec -T "$POSTGRES_SERVICE" \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
    "DELETE FROM outbox_events WHERE event_type = '${EVENT_TYPE}';"
  exit 0
fi

COUNT="${1:-5000}"
[[ "$COUNT" =~ ^[0-9]+$ ]] || { echo "ERROR: COUNT must be a positive integer" >&2; exit 1; }
echo "==> Inserting ${COUNT} synthetic outbox_events rows (tenant=${DEMO_TENANT_ID}, event_type=${EVENT_TYPE})..."
docker compose exec -T "$POSTGRES_SERVICE" \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "INSERT INTO outbox_events (tenant_id, event_type, payload)
   SELECT '${DEMO_TENANT_ID}'::uuid, '${EVENT_TYPE}', '{\"synthetic\": true}'::jsonb
   FROM generate_series(1, ${COUNT});"
echo "==> Done. Clean up afterward with: $0 --cleanup"
