# 2026-10-20 — openbao-deploy review nits (#980, #981, #982, #983)

Four non-blocking items from the #968 and #970 reviews, collected in one change.

- #982: the rollback env file check accepts digits in a service name (`rollback-[a-z0-9-]+.env`); test added.
- #981: `COMPOSE_PROFILES="a,b"` read from `.env` no longer keeps its quotes in the first and last profile
  name (new exported `parseComposeProfiles`), so rollback mode no longer skips profile-gated services such as
  `superset`; tests added.
- #980: the Python loader builds its urllib opener once in `make_opener` and passes it down, instead of
  rebuilding it on every request; behaviour is unchanged (same handlers).
- #983: the runbook says `novu-api` and `novu-worker` share one `rollback-novu.env`, exported once.
