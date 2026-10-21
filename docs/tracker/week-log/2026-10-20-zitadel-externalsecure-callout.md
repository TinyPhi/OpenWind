# 2026-10-20 — #1042: ZITADEL_EXTERNALSECURE call-out after the setup-guide removal

- `docs/runbooks/openbao-secrets.md`: a warning at the start of First-time setup that
  `ZITADEL_EXTERNALSECURE=true` must be set before Zitadel's first boot (the issuer scheme is stored at init
  and cannot be fixed without wiping Zitadel's database).
- `docs/deployment-hardening.md`: the TLS paragraph now links to that warning instead of the removed "setup
  guide", and the go-live checklist has an item for it.
- `docs/local-setup.md`: the Mixed Content troubleshooting entry pointed at "Step 3 in the production
  section", which #1039 removed; it now points at the runbook, and the snippet no longer mentions Step 3.
