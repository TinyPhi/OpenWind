#!/bin/sh
# Write runtime config into the built SPA so window.__CONFIG__ is populated.
# This runs every time the container starts — no rebuild needed to change config.
cat > /app/dist/env.js <<EOF
window.__CONFIG__ = {
  ZITADEL_ISSUER: "${ZITADEL_URL:-${ZITADEL_ISSUER}}",
  ZITADEL_OIDC_CLIENT_ID: "${ZITADEL_OIDC_CLIENT_ID}",
  API_URL: "${APP_URL}/api"
};
EOF

exec serve -s /app/dist -l 3000
