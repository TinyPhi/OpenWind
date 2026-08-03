#!/usr/bin/env bash
# dev-reset.sh — confirmed, full local-dev reset (#202).
#
# `docker compose down` (keeps volumes) and `docker compose down -v` (wipes
# them) are easy to confuse — picking the wrong one either leaves stale
# containers around or silently deletes all local Postgres/MinIO/etc. data.
# This wraps the destructive path behind an intent-revealing name and a
# confirmation prompt, and always wipes BOTH the openwind and zitadel
# volumes together: wiping only one side leaves a stale OIDC client secret
# that no longer matches the other side's fresh bootstrap, breaking login
# (see the "Resetting everything" section of docs/local-setup.md).
set -euo pipefail

OW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ZITA_DIR="$(dirname "$OW_DIR")/zitadel"

echo "This will stop containers and DELETE all local Postgres/Redis/MinIO/OpenBao"
echo "data for this checkout (and its Zitadel instance), then remove .env.local."
echo "Use 'pnpm dev:down' instead if you just want to stop containers and keep your data."
echo
read -r -p "Type 'reset' to continue: " confirm
if [ "$confirm" != "reset" ]; then
  echo "Aborted — nothing was deleted."
  exit 1
fi

cd "$OW_DIR"
docker compose down -v

if [ -d "$ZITA_DIR" ]; then
  (cd "$ZITA_DIR" && docker compose down -v)
else
  echo "Note: $ZITA_DIR not found — skipping (nothing to wipe there)."
fi

rm -f "$OW_DIR/.env.local"

echo
echo "Reset complete. Run ./setup.sh (or setup.bat) again for a fresh environment."
