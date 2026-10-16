# ADR-023: OpenBao as the Platform Secrets Manager — Separate Server, Startup Loader, One Path per Service

**Status:** Proposed
**Date:** 2026-10-14
**Deciders:** Tushar Sharma (Engineering Lead). Author: Bikash (@bikash-barnwal). Review requested:
@PrabhuVijit, @abmish.
**Tracking issue:** #911
**Related to:** ADR-001 (multitenancy — database roles; `migration_user` / `analytics_user`
connection strings never in application env), ADR-009 (connector runtime — Transit decrypt of
`connector_credentials`), ADR-015 (observability — the OpenBao health alert is **new** work under
this ADR), #1 and #7 (OpenBao chosen, Transit shipped), #455 (dev-mode exposure), #823 (persistent
OpenBao inside OpenWind's compose — closed; superseded in direction by this ADR), #368 (first
connectors that need to store credentials), #731 (its draft sets the Superset OAuth secret "via
OpenBao"; with this ADR that is the per-deployment `superset` path — see OQ-5).
**Supersedes:** —
**Superseded by:** —

---

## Context

### Problem — production secrets live in plain env files

- Every service gets its settings, secrets included, from env files: the committed `.env` (dev
  defaults, Superset signing keys among them) and the gitignored `.env.local` (database URLs,
  Zitadel keys, S3 keys, OAuth client secrets).
- `packages/config/src/env.ts` loads `.env.local` itself (walks up from the working directory,
  `override: false`) and then parses `process.env` at import time (`export const env = ...parse`).
- Several services see secrets they never use. `ow-frontend` mounts the whole `.env.local`
  (`docker-compose.yml`, `ow-frontend.volumes`). The worker receives `MIGRATION_DATABASE_URL`,
  which no worker code reads, contrary to ADR-001.
- Many compose entries hold dev secrets inline or interpolate them from the committed `.env`
  (`postgres`, `pgbouncer`, `ow-backend`, `ow-worker`, `bootstrap`, `superset`, `superset-init`,
  `novu-api`, `novu-worker`), and `docker/postgres/init/001_setup.sql` sets every DB role password.

OpenBao today is used for one thing only: Transit decrypt of connector credentials
(`packages/secrets/src/openbao.ts`), against a **dev-mode** container (`docker-compose.yml`,
service `openbao`: in-memory, hardcoded root token). `ow-backend` and `ow-worker` depend on it.

### What changed

A persistent, TLS-protected OpenBao server, run from a separate operations repository (Raft
storage, manual Shamir unseal, file audit device, AppRole per service), is now live on the same
host as a production OpenWind instance. It gives each project:

- one AppRole per service (role ID + secret ID), bound to source addresses;
- one KV v2 path per service: `secret/<project>/<env>/<service>`;
- Transit keys.

### What was tested, and what wasn't

A prototype was run locally on 2026-10-13 against a demo OpenBao with a private CA:

- **Tested:** `ow-backend`, `ow-worker`, `ow-frontend` and `superset` started with settings only
  from OpenBao; least privilege (403 on another service's path, 400 on another tenant's
  ciphertext); fail-closed on a wrong secret ID, an unreachable server, or a missing key.
- **Not tested:** Novu, `bootstrap`, `superset-init`; the production network path; bounded retry;
  credential stripping; the precedence rule in Decision 2 (the prototype let compose values win,
  including empty ones).

### What's already decided (not re-litigated here)

- OpenBao is the platform's secrets manager (#1, #7).
- Connector credentials are encrypted with Transit (ADR-009).
- Production must not use dev-mode OpenBao or a root token (`docs/deployment-hardening.md`,
  "Production OpenBao").

### What THIS ADR must decide

1. Where OpenBao runs relative to OpenWind.
2. How settings and secrets reach each service, and which source wins.
3. Access boundaries between services, and Transit permissions.
4. Behavior when OpenBao is unavailable.
5. How OpenWind reaches OpenBao, and how the server is authenticated.
6. What happens to existing secrets on the running instance.
7. What stays the same for local development and for self-hosters.

---

## Decision

### Decision 1 — OpenBao runs as a separate server; the dev OpenBao is not started in production

- OpenWind connects to a separate OpenBao server. The dev `openbao` / `openbao-init` services stay
  for local development only.
- Enforcement lives **only in the production override** (`docker-compose.prod.yml`); the base
  `docker-compose.yml` keeps `openbao` / `openbao-init` without a profile, so a plain
  `docker compose up` on a laptop starts them exactly as today. Compose profiles are opt-in (a
  service with a profile starts only when that profile is activated), so the override assigns
  `openbao` and `openbao-init` a profile that is never activated in production, and replaces the
  `depends_on` of `ow-backend` / `ow-worker` with `depends_on: !override` listing the remaining
  dependencies (`pgbouncer` and `redis`; plus `clamav` for the worker). It also replaces the base
  `OPENBAO_ADDR: http://openbao:8200`. Verified with Docker Compose v5.3.0: the profile removes the
  service from `config --services`; without changing `depends_on`, Compose rejects the project
  ("depends on undefined service"); and `depends_on: !reset {}` would drop **every** dependency,
  not only OpenBao, which breaks start-up order.
- "Not started" is not "can't start": activating that profile name (for example through
  `COMPOSE_PROFILES`) would start it again (tested). So the override also makes the dev OpenBao
  inert if it is ever started (no published ports, and its command replaced so it exits), and the
  check script below fails if `COMPOSE_PROFILES` or `--profile` activates it.
- The override removes `.env.local` from `env_file` with `env_file: !reset []`. A plain empty list
  does **not** remove the base entry (tested).
- A check script asserts that the rendered production config
  (`docker compose -f docker-compose.yml -f docker-compose.prod.yml config --no-interpolate
--no-env-resolution`) contains no `openbao` service, no `.env.local` `env_file` or mount, and no `environment:` key outside the per-service
  non-secret allowlist (OQ-1). The allowlist is the definition of "allowed"; anything not on it
  fails. The script prints only key names and verdicts, never values: plain `config` prints every
  resolved value, and the two flags stop interpolation but still print values written directly in
  a compose file (tested). The script is finalised together with OQ-1 in the loader PR. Wiring it
  into CI is a maintainer change to `.github/workflows/`.
- Requires Docker Compose ≥ 2.24.4 (`!override` / `!reset`).

**Why:** running, unsealing, backing up and auditing OpenBao is an operations job with its own
runbook, shared by several projects. A dev OpenBao with a published root token must not be
reachable on a production host.

### Decision 2 — A startup loader delivers settings; OpenBao values win

- Each secret-holding container's entrypoint is a small loader (Node for backend, worker,
  bootstrap and Novu; Python for Superset). It logs in with AppRole, reads **one** KV path,
  revokes its own token, checks required keys, then starts the original command with the values as
  ordinary env vars.
- **Precedence:** OpenBao values win. Compose may set only keys on an explicit non-secret
  allowlist (container wiring such as `REDIS_URL`, `CLAMAV_HOST`). If a key is set by both compose
  and OpenBao and isn't allowlisted, the loader refuses to start.
- **`.env.local` is not a fallback in production:** `env.ts` stops loading `.env.local` when
  `NODE_ENV=production`, so a key missing from OpenBao fails at start instead of being filled from
  a stray file.
- The loader never prints values, only key names and counts. It refuses a non-`https`
  `OPENBAO_ADDR`.
- The loader's role ID and secret ID are passed to the child **only** for backend and worker
  (they call Transit at runtime). Other services' children don't receive them.
- The loader lives in the repo (`packages/openbao-deploy/`, a workspace package so CI runs its
  tests) and is copied into the images at build time, never bind-mounted from a host path.
  Third-party images (Novu) are rebuilt from their pinned digests with the loader added.
- Required-key lists are derived from what each service's config actually requires, not
  hand-written.

**Why:** `env.ts` parses synchronously at import time; adding remote reads there would change how
every app, script and test loads config. Superset is Python and needs its own client anyway. The
loader keeps `@platform/config` the only place the Node apps read config from.

**Amends `.claude/rules/security.md`:** its `packages/secrets` paragraph says no other code reads
from the vault and claims leases, token renewal and a `packages/secrets/README.md` that don't
exist. It will say: the startup loader reads KV once at start; `@platform/secrets` is the only
**runtime** vault client; the README is added.

### Decision 3 — One role and one exact path per secret-holding service; no role for services without secrets

| Service                                  | KV path                                                                       | Transit                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `ow-backend`                             | `secret/openwind/<env>/backend`                                               | decrypt (encrypt only when a credential write path lands, see Decision 8) |
| `ow-worker`                              | `secret/openwind/<env>/worker`                                                | decrypt                                                                   |
| `superset`                               | `secret/openwind/<env>/superset`                                              | —                                                                         |
| `superset-init`, `bootstrap` (one-shots) | `.../superset-init`, `.../bootstrap`                                          | —                                                                         |
| `novu-api`, `novu-worker`                | `secret/openwind/<env>/novu`                                                  | —                                                                         |
| `ow-frontend`                            | **no role** — holds only public values (issuer URL, OIDC client ID, UI flags) | —                                                                         |

- No wildcards. A value two services need is stored at both paths.
- The worker path does **not** hold `MIGRATION_DATABASE_URL` (ADR-001); only `bootstrap` does.
- `ow-frontend`'s `.env.local` mount is replaced by an empty file in production. Its public values
  (`ZITADEL_ISSUER`, `ZITADEL_OIDC_CLIENT_ID`, UI flags) come from non-secret `environment:`
  entries in the production override (on the OQ-1 allowlist); `apps/admin-ui/vite.config.ts` reads
  them through `loadEnv` and serves them at `/env.js`. The OIDC client secret is never set there.
- **Exception:** the pgbouncer image has no Node or Python; its DB password comes from a
  server-only file (mode 0600) until a follow-up moves it (OQ-3).

**Why:** limits what one compromised container exposes and makes every read attributable in the
audit log. The frontend is the most exposed container (Vite dev server, published port), so it
gets no credential.

### Decision 4 — Fail closed, without restart storms

- If OpenBao is unreachable, sealed, rejects the login, or a required key is missing, the app does
  not start.
- On "unreachable" or 503 (sealed), the loader retries with backoff for a bounded time (about 2
  minutes) before exiting. On 400/403 it does not retry, and it sleeps before exiting so
  `restart: unless-stopped` can't turn a revoked secret ID into a tight login loop. One-shots use
  `restart: on-failure:3`. **To be implemented** (not in the prototype).
- At runtime, `@platform/secrets` gets a request timeout, retry on network errors / 429 / 5xx,
  token renewal at about 2/3 of its TTL, single-flight login, and one re-login on 403. This is
  what the OpenBao operations repo's client-integration guide already requires. Today the client
  has no timeout and caches its token until a 403 (`packages/secrets/src/client.ts`).

**Cost:** after a host reboot, OpenWind waits until OpenBao is unsealed (manual Shamir unseal).
Accepted for now; see Consequences and OQ-6.

### Decision 5 — Private network per project; OpenBao authenticated by name and address

- OpenBao joins a **dedicated network per project** (`openbao-openwind`) that only OpenBao and
  OpenWind's secret-holding services join. OpenWind does not join the shared OpenBao network, and
  never goes through the reverse proxy in front of OpenBao: through the proxy, the address lock
  only sees the proxy's address.
- The per-project network has a **fixed subnet** with a reserved `ip_range` for Docker's own
  assignments, and each OpenWind service gets a **fixed address** outside that range. Roles are
  bound (`secret_id_bound_cidrs`, `token_bound_cidrs`) to those **exact container addresses**
  (`/32`), never to the whole subnet. Reason: traffic reaching OpenBao through a published port
  arrives with the network gateway's address, which is inside the subnet, so a subnet-wide binding
  would let outside callers through (observed on Docker Desktop; re-test on the Linux host).
- After deployment, a login attempt from outside the allowed addresses must be shown to fail.
- `OPENBAO_ADDR` is the server's certificate name, resolved to OpenBao on that network (network
  alias). The loader refuses to send credentials unless the name resolves to an address inside
  that network's subnet, so a container missing from the network can't leak its secret ID to the
  public path.
- The subnet the loader checks against comes from `OPENBAO_NETWORK_CIDR`, a non-secret value set by
  the production override and listed on the OQ-1 allowlist. It is not baked into images (images
  stay project-neutral) and not read from the Docker socket (no socket access inside containers).

**Why:** a shared network without a reserved address range lets another project's container take
OpenWind's address and pass the address check with a stolen secret ID. A per-project network
removes that, and keeps address binding meaningful. This needs a change on the OpenBao operations
side (outside this repository).

### Decision 5a — Secret ID lifetime and use count

| Setting                       | Value                                                                      | Why                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secret_id_num_uses`          | `0` (unlimited)                                                            | The loader logs in once at start, and backend and worker log in again at runtime for Transit whenever their token can no longer be renewed (after `token_max_ttl`, or a 403). Each login uses one use. `1` would make the first runtime re-login fail; `2` would fail on the second; any finite number turns a long-running service into a time bomb. The OpenBao operations repo's onboarding already sets `0`. |
| `secret_id_ttl`               | finite, for example 30 days                                                | Unlimited uses must not also mean unlimited time. A leaked secret ID stops working at the next rotation. Rotation is a documented runbook step with an alert at half-life; today's operations default is "never expires", so this is a change there.                                                                                                                                                             |
| `token_ttl` / `token_max_ttl` | short, for example 1h / 4h                                                 | The runtime client renews at about 2/3 of the TTL and re-logs in (single-flight) only when renewal is no longer possible (Decision 4).                                                                                                                                                                                                                                                                           |
| Binding                       | `secret_id_bound_cidrs` and `token_bound_cidrs` on the per-project network | A stolen secret ID or token is useless from anywhere else (Decision 5).                                                                                                                                                                                                                                                                                                                                          |

**Trade-off recorded:** with `num_uses=0`, a secret ID copied off the host works until it expires
or is rotated, **from inside the per-project network**. The residual risk is bounded by the
network binding, the finite TTL and the audit log, and delivering the secret ID as a file instead
of an env var (OQ-2) narrows who can copy it. Per-start single-use secret IDs (response-wrapped,
delivered by an orchestrator) would remove it but need tooling OpenWind's compose deployment
doesn't have; out of scope here.

### Decision 6 — Moving the running instance: rotate what's cheap first, copy what protects data

- **Rotate before cutover** every secret whose current value is published in this repo and is
  cheap to rotate: Postgres role passwords (and pgbouncer's copy), Novu `JWT_SECRET`, Superset
  service-account and admin passwords, `REPORTING_BINDING_SECRET` (committed in `.env`; re-run
  migrations after rotating, since they copy it into `reporting_binding_key`), `METRICS_TOKEN`
  (`env.ts` defaults it to a value in the repo, with no production guard; a guard is added) and
  the Grafana admin password (defaults to `admin`) if the observability profile is ever enabled.
  Loading a publicly known value into OpenBao gives no confidentiality.
- **Copy, don't regenerate,** keys that protect stored data: Superset `SECRET_KEY` (it encrypts
  the reporting DB password Superset stores) and Novu `STORE_ENCRYPTION_KEY` (it encrypts saved
  provider credentials). Each gets a dated rotation plan (`superset re-encrypt-secrets`; Novu
  integrations re-entered). Until rotated, this ADR does **not** claim confidentiality for them.
- Bootstrap does not run against production until it stops regenerating the Zitadel introspection
  secret on every run and stops writing secrets to `.env.local` (`scripts/bootstrap.ts`,
  `runZitadelSetup`).
- After a verified export into OpenBao, `.env.local` is removed from the server.
- **Rollback:** keep the production override, with the loader switched off and a one-time rollback
  env file (mode 0600, exported from OpenBao by the runbook owner, deleted after use). Starting
  without the override would not work: the base compose sets values inline (for example
  `DATABASE_URL` with dev passwords) that win over any `env_file` (tested), and it would start the
  dev OpenBao. Rollback is rehearsed before cutover.
- **Restore test:** an OpenBao restore, and a joint database + OpenBao restore, are tested before
  cutover. A database restore is useless for connector credentials without the matching Transit
  key.

### Decision 7 — OpenBao is the default; a Vault-API Transit server is required in production

OpenWind is open source; self-hosters choose their own tooling.

- **Settings and secrets:** the apps read ordinary environment variables. The loader is used only
  by the opt-in production override. Self-hosters can fill the same variables from any source
  (Vault Agent, a cloud secrets manager, Kubernetes secrets, env files) with no code change. The
  contract is the variable names in `.env.example`.
- **Connector credential encryption:** requires a Vault-API Transit server (OpenBao or HashiCorp
  Vault) in production. Limits today: the `transit/` and `auth/approle/` paths are fixed, Vault
  namespaces aren't supported, and decrypt chooses the backend by ciphertext prefix. Another KMS
  needs a new provider (edits to the `SECRETS_PROVIDER` enum, `transit.ts` and the ciphertext
  format).
- **Production guards:** refuse `SECRETS_PROVIDER=local`, refuse a static `OPENBAO_TOKEN`, require
  `https`, treat empty values as unset, and **reject `local:` ciphertext on decrypt** (the `local`
  provider's key is published in the repo). A provider that lets the backend run without Transit
  when no connectors are installed is a follow-up (OQ-4).
- **Before the `local:` guard is enabled:** the implementing PR includes a read-only check that
  counts `connector_credentials` values with the `local:` prefix, and the runbook requires it to
  return zero on each production database first. Nothing in the application can encrypt today
  (`encryptCredential` has no caller), so such rows could only come from manual inserts. If any
  exist, they are re-entered through the credential write path (Decision 8) before the guard is
  enabled, rather than failing at decrypt.

### Decision 8 — Transit key settings and permissions

- Key: one per environment, `derived=true`, `exportable=false`, `allow_plaintext_backup=false`,
  `deletion_allowed=false`. Rotation creates a new version; a rewrap job moves old ciphertext
  forward before `min_decryption_version` is raised.
- **Target:** backend and worker get `decrypt` only; `encrypt` is granted with the first credential
  write path (an admin CLI first; #368's connectors after). **Today** the operations repo's policy
  template grants both `encrypt` and `decrypt` on a service's key, Transit keys are defined per
  project file, there is no `rewrap` permission and no key-rotation job. Each is an
  operations-repo change (see Consequences).
- **Derivation is not access control.** A token that can decrypt can decrypt any tenant's
  ciphertext by supplying that tenant's ID as context. Tenant isolation for credentials rests on
  the application (RLS on `connector_credentials`, tenant-scoped reads), not on OpenBao. RLS on
  that table is enabled but **not forced** (migration `0001_rls_and_tenancy.sql`), so the table
  owner and `migration_user` (`BYPASSRLS`) are not subject to it.

---

## Security

### Trust boundaries

- **OpenBao operators and admins** of the shared server can read and change OpenWind's secrets.
- **Key custody is not yet separated.** Today, control of the OpenBao host plus one operator's
  credential is enough to unseal OpenBao and to read every project's secrets; unseal material,
  administration and backups are not split across people or machines. Documenting and splitting
  key custody is an operations-repo change, tracked in OQ-6.
- **Anyone with Docker or root access on the host** can read role IDs and secret IDs
  (`docker inspect`, `/proc/<pid>/environ`, the role files) and the running services'
  environments.
- **Other projects** on the same OpenBao server are isolated by policy and, with Decision 5, by
  network.

### Threat model (STRIDE)

| Threat                      | Example                                                                                                                                                                                                                                            | Control                                                                                                                                                                                                            | Residual                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing (client)           | Stolen secret ID used elsewhere                                                                                                                                                                                                                    | Address binding on a per-project network; one role per service; finite secret ID TTL                                                                                                                               | Host root / Docker access reads the secret ID; secret ID as a file instead of env is OQ-2                                                                |
| Spoofing (server)           | Container off the network resolves the public name and sends its secret ID to the proxy                                                                                                                                                            | Loader checks the resolved address is inside the project network; `https` only                                                                                                                                     | Any public CA can issue a certificate for the name (OQ-7: pin issuer/SPKI)                                                                               |
| Tampering (secrets)         | Values changed silently                                                                                                                                                                                                                            | Changes only through OpenBao admin; audit log; KV v2 versions                                                                                                                                                      | Admin token holders can change values                                                                                                                    |
| Tampering (loader / images) | Modified loader reads or leaks values                                                                                                                                                                                                              | Loader in repo, reviewed, baked into images; images pinned                                                                                                                                                         | Bootstrap image installs tools unpinned (OQ-8)                                                                                                           |
| Repudiation                 | Who read what                                                                                                                                                                                                                                      | Audit log on every login and read (values HMAC'd; raw logging off)                                                                                                                                                 | Retention and access owned by the operations repo                                                                                                        |
| Information disclosure      | Secrets in git, env files, `docker inspect`, logs, unused services                                                                                                                                                                                 | OpenBao wins; compose holds only allowlisted wiring; `.env.local` not loaded in production and removed; per-service paths; frontend gets no role; loader never logs values; `.env` and `.git` excluded from images | Process environment readable by root in the container; data-protecting keys still carry dev-known values until rotated (Decision 6)                      |
| Denial of service           | OpenBao sealed, down, audit device full; restart loops; each failed inbound webhook makes one OpenBao call (timing-equalisation decrypt), and today that call has no timeout, so a stuck call can hold a request until the proxy or server timeout | Bounded retry; sleep on 4xx; client timeout of 5–10 s with retry, renewal; the existing global API rate limit covers webhook routes; health alert; runbook                                                         | One server and manual unseal are a shared single point of failure (OQ-6); overload of OpenBao from webhook traffic is untested (no production load test) |
| Elevation of privilege      | `local` provider or `local:` ciphertext in production; dev root-token OpenBao reachable; address squatting                                                                                                                                         | Production guards incl. `local:` decrypt rejection; dev OpenBao profile + config check; per-project network                                                                                                        | Guards in `env.ts` cover Node services only; Superset key checks are to be added in `superset_config.py` (today it only refuses missing keys)            |

### Inherited controls (and their limits)

- Transit derived context binds ciphertext to a tenant; it does not restrict which tenant a
  decrypt-capable token can decrypt (Decision 8).
- Loopback-only ports for infrastructure (#455/#478). Exceptions remain: `novu-api` (3010),
  `novu-web` (4200) and `ow-frontend` (3001) are published on all interfaces.
- Existing production refines in `env.ts` (dev defaults refused, key length).

### Gaps verified in code (each tracked by an issue before merge)

| Gap                                                                                          | Where                                                      | Fixed by          |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------- |
| No timeout/retry; token cached until a 403 (about one Transit failure an hour with a 1h TTL) | `packages/secrets/src/client.ts`                           | Decision 4        |
| `OPENBAO_TOKEN=""` passes the config check                                                   | `env.ts` OpenBao refine                                    | Decision 7        |
| `local:` ciphertext decrypts with the published key regardless of provider                   | `packages/secrets/src/transit.ts`                          | Decision 7        |
| `.env.local` silently fills missing keys                                                     | `env.ts` `findEnvLocal`                                    | Decision 2        |
| Bootstrap regenerates the introspection secret every run and writes `.env.local`             | `scripts/bootstrap.ts`                                     | Decision 6        |
| Nothing can create a connector credential (`encryptCredential` has no caller)                | `packages/secrets`                                         | Decision 8 / #368 |
| `.env` and `.git` copied into the bootstrap image                                            | `.dockerignore`, `Dockerfile.bootstrap`                    | Decision 2        |
| Dev secrets inline or from committed `.env` in compose; DB role passwords in init SQL        | `docker-compose.yml`, `docker/postgres/init/001_setup.sql` | Decisions 2, 6    |
| Worker gets `MIGRATION_DATABASE_URL` (contrary to ADR-001)                                   | `docker-compose.yml` `ow-worker`                           | Decision 3        |
| `security.md` describes leases/renewal/README that don't exist                               | `.claude/rules/security.md`                                | Decision 2        |
| `METRICS_TOKEN` defaults to a value in the repo, with no production guard                    | `packages/config/src/env.ts`                               | Decision 6        |

---

## Consequences

**Positive**

- In production, secrets come only from OpenBao; compose holds wiring only; `.env.local` is gone.
- Each service sees only its own secrets; every read is audited.
- Local development is unchanged: the base `docker-compose.yml` keeps the dev OpenBao with no
  profile; only the production override disables it (Decision 1).

**Negative / costs**

- OpenWind can't start while OpenBao is sealed or down.
- Changing a secret needs a service restart (values are read at start).
- Code changes are needed: `env.ts` guards and `.env.local` handling, `@platform/secrets` client
  hardening, the loaders, a production compose override, bootstrap changes, `superset_config.py`
  key checks, `.dockerignore`.
- Two loaders (Node, Python) to maintain.
- Depends on changes in the OpenBao operations repo: per-project network with a fixed subnet and
  reserved `ip_range`; finite secret ID TTL; a policy template that can grant `decrypt` without
  `encrypt`; a `rewrap` permission and a key-rotation job; split key custody (OQ-6).
- Data-protecting Superset and Novu keys keep dev-known values until their dated rotation.
- Runbook (owner: Bikash): unseal order after reboot, secret ID and key rotation, certificate
  renewal reload, joint DB + OpenBao restore (a DB restore is useless for credentials without the
  matching Transit key).

---

## Alternatives considered

| Alternative                                                             | Trade-off                                            | Why not chosen                                                                                                                 |
| ----------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| OpenBao inside OpenWind's compose (#823 direction)                      | One stack, no cross-project dependency               | Duplicates the operations repo; that server now exists                                                                         |
| Read KV in app code (sync pre-start step in each entrypoint)            | No extra process; one language                       | Still needs a separate Python client for Superset and more code paths in each app; the loader covers all services the same way |
| OpenBao Agent (templating, `exit_after_auth`, shared volume or sidecar) | Maintained upstream; renewal and templating built in | More moving parts per service; worth revisiting if the loader grows. Agent `exec` mode is public beta                          |
| Through the reverse proxy with forwarded-address trust                  | No network changes                                   | Needs proxy and listener config on both sides; address binding depends on header trust                                         |
| Shared OpenBao network with reserved fixed addresses                    | No new network                                       | Relies on IPAM range reservation and has no anti-spoofing between neighbours                                                   |
| Frontend on OpenBao                                                     | One rule for every service                           | Adds a credential to the most exposed container for public values only                                                         |
| Auto-unseal (Transit or cloud KMS)                                      | No outage waiting for unseal after a reboot          | Needs another trusted key service; operations repo decision (OQ-6)                                                             |

---

## Open questions

| ID   | Question                                                                           | Status                          | Evidence / answer                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---- | ---------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 | Exact non-secret allowlist per service for Decision 2                              | Open — settled in the loader PR | Derived from the config schema and compose wiring                                                                                                                                                                                                                                                                                                                                                                                                                            |
| OQ-2 | Deliver the secret ID as a file (`*_FILE`, compose secrets) instead of env         | Deferred — issue to file        | Removes exposure via `docker inspect`; needs loader, `env.ts`, client changes                                                                                                                                                                                                                                                                                                                                                                                                |
| OQ-3 | Move pgbouncer's password into OpenBao                                             | Deferred — issue to file        | Image has no Node/Python; options: shell loader, `auth_query`                                                                                                                                                                                                                                                                                                                                                                                                                |
| OQ-4 | Let the backend run in production without Transit when no connectors are installed | Deferred — issue to file        | Today `SECRETS_PROVIDER` is `openbao` or `local` only                                                                                                                                                                                                                                                                                                                                                                                                                        |
| OQ-5 | Does Superset OAuth (#731, ADR-019 Stage 2) need per-tenant secrets?               | Closed — no                     | `SUPERSET_OAUTH_CLIENT_ID` / secret are one value per deployment (one Superset OAuth client per Zitadel instance); `superset_config.py` reads a single env var; ADR-019 Decision 9 resolves the tenant at login from the org claim (`tenant_for_org()`), not from a per-tenant secret. Covered by Decision 3 (`superset` path). #731's draft wording "the tenant's secrets" is loose. Truly per-tenant secrets are out of scope for this ADR and would need their own design |
| OQ-6 | Unseal model and availability target (RTO, on-call beyond one owner, auto-unseal)  | Open — operations repo          | Manual Shamir unseal today                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| OQ-7 | Pin the OpenBao server certificate issuer or key                                   | Deferred — issue to file        | Public CA today                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| OQ-8 | Pin bootstrap image tooling (`--frozen-lockfile`, pinned global tools)             | Deferred — issue to file        | `Dockerfile.bootstrap` installs unpinned                                                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## Implementation plan

One PR each, after this ADR is accepted:

1. `@platform/secrets` client hardening + tests + README, **and the `.claude/rules/security.md`
   amendment (Decision 2)**, so every later PR is reviewed against accurate guidance.
2. `env.ts` production guards, `.env.local` handling, `local:` decrypt rejection, and the read-only
   `local:` row check that must pass before the guard is enabled (Decision 7).
3. Loaders (Node, Python) with tests, baked into images; the OQ-1 allowlist; `OPENBAO_NETWORK_CIDR`
   check.
4. Bootstrap: no regeneration without an explicit flag; no `.env.local` writes in production.
5. Compose base: Superset secrets no longer required from `.env`; Superset key checks;
   `.dockerignore`. The dev OpenBao stays as it is in the base file.
6. `docker-compose.prod.yml` (dev OpenBao disabled by profile + `depends_on` reset, Decision 1),
   `.env.production.example`, pgbouncer file, Novu, config check script.
7. Admin CLI to create connector credentials (Transit encrypt), coordinated with #368.
8. Remaining docs and runbook: `.env.example`, `local-setup.md`, `deployment-hardening.md`,
   backup/DR runbook, OpenBao health alert.
