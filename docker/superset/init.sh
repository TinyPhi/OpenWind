#!/bin/bash
# Superset one-shot initialisation — OpenWind reporting (track 3G).
#
# Runs to completion and exits; the superset service waits on that via
# service_completed_successfully, so the app never serves an unmigrated
# metadata database.
#
# Idempotent by design — compose re-runs this on every `up`, and a second run
# must be a no-op rather than resetting anything.

set -euo pipefail

# The admin password is required, never defaulted. An admin account on a
# guessable password is the "anyone on the network reaches Superset and uses it
# as admin" threat in the spec's §S; @platform/config independently refuses to
# start the API in production if this is still its development value.
: "${SUPERSET_ADMIN_PASSWORD:?SUPERSET_ADMIN_PASSWORD is required}"

SUPERSET_ADMIN_USER="${SUPERSET_ADMIN_USER:-admin}"
SUPERSET_ADMIN_EMAIL="${SUPERSET_ADMIN_EMAIL:-admin@openwind.local}"

echo "[superset-init] upgrading metadata database..."
superset db upgrade

echo "[superset-init] ensuring admin user '${SUPERSET_ADMIN_USER}'..."
# create-admin is a no-op when the user already exists — including when the
# configured password has since changed. Left at that, rotating
# SUPERSET_ADMIN_PASSWORD would appear to work and silently keep the old
# password, so the reset below runs unconditionally afterwards.
superset fab create-admin \
  --username "${SUPERSET_ADMIN_USER}" \
  --firstname Admin \
  --lastname User \
  --email "${SUPERSET_ADMIN_EMAIL}" \
  --password "${SUPERSET_ADMIN_PASSWORD}" || echo "[superset-init] admin already exists"

# Make the configured password authoritative on every run.
superset fab reset-password \
  --username "${SUPERSET_ADMIN_USER}" \
  --password "${SUPERSET_ADMIN_PASSWORD}"

echo "[superset-init] applying default roles..."
superset init

# Must run after `superset init` — that is what creates the permission/view
# rows the provisioning script grants, so running it earlier would find
# nothing to grant and log every permission as missing.
echo "[superset-init] provisioning reporting..."
python /app/bootstrap.py

echo "[superset-init] done."
