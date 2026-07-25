# OpenWind Setup Guide

This guide covers everything needed to run OpenWind locally for development and
to deploy it to a production server with HTTPS. Read the section that applies to
your goal.

**Architecture note:** Zitadel (the identity provider) is provisioned as a
**separate Docker Compose project** in a `../zitadel/` folder next to this repo
— not as a service inside this repo's `docker-compose.yml`. The `setup.sh` /
`setup.bat` script creates that folder, starts Zitadel in it, and connects the
two projects over a shared external Docker network (`openwind_zitadel`). Keep
this in mind whenever a command below targets "the zitadel compose project" —
it means `cd ../zitadel && docker compose ...`, not a `zitadel` service in this
repo's compose file (there isn't one).

---

## Table of contents

- [Local development](#local-development)
- [Production deployment (HTTPS)](#production-deployment-https)
- [What setup does — step by step](#what-setup-does--step-by-step)
- [Services reference](#services-reference)
- [Environment variables reference](#environment-variables-reference)
- [Database operations](#database-operations)
- [Troubleshooting](#troubleshooting)

---

## Local development

### Prerequisites

**Single requirement: Docker Desktop (must be running).** No Node.js, no pnpm,
no other tooling — the one-time setup itself runs entirely inside containers.

| Tool           | Minimum version | Install                            |
| -------------- | --------------- | ---------------------------------- |
| Docker Desktop | 24              | https://docs.docker.com/get-docker |

(Node 22 / pnpm 9 are only needed if you want `pnpm dev` hot-reload outside
Docker — see [Day-to-day commands](#day-to-day-commands). The setup script
itself doesn't need them.)

### First-time setup

```bash
git clone <repo-url> openwind
cd openwind

setup.bat          # Windows — double-click it, or run from PowerShell/CMD
./setup.sh         # Linux / Mac
```

That's the entire setup — one command, nothing to configure first. It takes
3–5 minutes on first run and fully automates:

1. **Zitadel provisioning** — creates `../zitadel/` next to this repo with a
   generated `docker-compose.yml`, and starts the identity provider. A random
   `ZITADEL_MASTERKEY` and `ZITADEL_ADMIN_PASSWORD` are generated and saved to
   `.env.local` (re-running the script reuses them instead of regenerating).
2. **Bootstrap PAT generation** — a throwaway Node.js container logs into
   Zitadel headlessly (simulating the browser login form) and creates a
   Personal Access Token. The PAT is never written to disk — it's piped
   straight into the bootstrap container's environment and discarded after.
3. **OpenWind bootstrap** — runs database migrations, seeds dev data,
   configures the Zitadel OIDC app (project, roles, redirect URIs), and
   creates demo users. All resulting credentials are written to `.env.local`
   (gitignored).
4. **App start** — brings up `ow-backend` and `ow-frontend` with the freshly
   written credentials.

**When it finishes**, the script prints everything you need directly to the
terminal — no digging through `.env.local` required:

```
  =============================================
   Done!

   OpenWind:  http://localhost:3001
   Zitadel:   http://localhost:8080
  =============================================

   Zitadel admin (identity provider console):
     owZitadelAdmin@openwind.local / <generated password>

   OpenWind app:
     owAdmin / OpenWind1234!   (admin)
     owUser  / OpenWind1234!   (user)
```

Open `http://localhost:3001` and log in with `owAdmin` / `OpenWind1234!`.

### Multiple checkouts on the same machine

`setup.sh`/`setup.bat` derive a Docker Compose project name from this
checkout's **absolute path** and set it automatically for every command they
run — so a test clone, a coworker's fork, or any other checkout on the same
machine gets its own isolated Postgres/Redis/Zitadel volumes, never the
real dev environment's. The derived name is printed at the end of every run
(`This checkout's Docker Compose project: openwind-xxxxxxxx`).

This isolation only applies automatically **inside** `setup.sh`/`setup.bat`.
If you run bare `docker compose ...` commands yourself in a fresh terminal,
export the printed project name first — otherwise commands like `docker
compose down -v` fall back to the shared, non-isolated `openwind` project name
baked into `docker-compose.yml`:

```bash
export COMPOSE_PROJECT_NAME=openwind-xxxxxxxx   # value from the setup summary
```

(The `../zitadel/` project doesn't need this — its generated `docker-compose.yml`
has the isolated name baked in directly, so plain `docker compose` commands
there are always correctly scoped.)

### Resetting everything

```bash
docker compose down -v                              # stop app containers, wipe their volumes
(cd ../zitadel && docker compose down -v)            # wipe Zitadel's volume too
rm .env.local                                        # remove generated credentials
setup.bat   # or ./setup.sh                          # full setup again from scratch
```

> Wipe **both** volumes together. If only the OpenWind side is wiped, the old
> Zitadel instance still has the previous OIDC app/client secret, which no
> longer matches what the fresh bootstrap will write to `.env.local` — and
> login breaks. Same problem in reverse if only Zitadel is wiped.
>
> If you're resetting a non-default checkout, `export COMPOSE_PROJECT_NAME=...`
> first (see above) so `docker compose down -v` targets the right volumes.

### Day-to-day commands

```bash
pnpm dev                               # start API + frontend with hot reload (outside Docker)
docker compose up -d                   # start OpenWind's own services in Docker
docker compose down                    # stop (data preserved)
docker compose logs -f ow-backend      # tail API logs
docker compose restart ow-frontend     # restart one container
```

These only affect the containers defined in this repo's `docker-compose.yml`
(Postgres, Redis, API, frontend). Zitadel lives in the separate `../zitadel/`
compose project and keeps running independently — `docker compose down` here
does not touch it.

---

## Production deployment (HTTPS)

Production uses the same `setup.sh` script as local dev — you configure it via
environment variables instead of a different flow. The one thing that differs
in a way that matters: **Zitadel must know it is running behind HTTPS before
its very first boot.** Zitadel bakes the issuer URL into its database during
`start-from-init`. If it initialises with `http://`, the issuer stays
`http://` permanently until you wipe the database and start again — and the
browser will block every auth request on an HTTPS page as mixed content.

Follow these steps in order.

### Step 1 — Prerequisites on the server

- Docker and Docker Compose (v2) installed
- A reverse proxy (nginx, Caddy, Traefik) handling SSL termination and forwarding
  traffic to the container ports you choose below
- Two subdomains with valid HTTPS certificates:
  - `openwind.example.com` → forwards to the frontend's host port
  - `owzitadel.example.com` → forwards to Zitadel's host port

### Step 2 — Clone the repo

```bash
git clone <repo-url> ~/openwind
cd ~/openwind
```

### Step 3 — Set the deployment env vars

`setup.sh` reads these from the environment (export them, or put them in a
gitignored `.env.server` and `source` it first). **Set these before the first
run** — `ZITADEL_EXTERNALSECURE` in particular cannot be changed later without
wiping Zitadel's database:

```bash
export ZITADEL_EXTERNAL_DOMAIN=owzitadel.example.com
export ZITADEL_HOST_PORT=10405          # host port Zitadel binds to
export ZITADEL_EXTERNALSECURE=true      # CRITICAL — must be true before first boot
export ZITADEL_EXTERNAL_PORT=443        # public port browsers use (behind the proxy)
export ZITADEL_TLS_MODE=disabled        # TLS terminates at the reverse proxy, not Zitadel
export ADMIN_UI_HOST_PORT=10404         # host port the frontend binds to
export APP_URL=https://openwind.example.com
```

**Why `ZITADEL_EXTERNALSECURE=true` matters:** `start-from-init` reads
`ZITADEL_EXTERNALDOMAIN` / `ZITADEL_EXTERNALPORT` / `ZITADEL_EXTERNALSECURE`
and writes the instance's issuer URL — `{scheme}://{domain}` — into its
database once, on first boot. `true` gives `https://`; absent or `false` gives
`http://` forever, until you wipe the database and reinitialise. There is no
in-place migration.

### Step 4 — Run setup

```bash
cd ~/openwind
./setup.sh
```

Same script, same four steps as local dev — it just picks up the env vars from
Step 3 and generates HTTPS-correct URLs and OIDC redirect URIs throughout. It
prints the same summary block with both URLs and both sets of credentials at
the end.

### Step 5 — Verify

- App: `https://openwind.example.com` → log in with `owAdmin` / `OpenWind1234!`
- Zitadel console: `https://owzitadel.example.com/ui/console` → log in with
  `owZitadelAdmin@openwind.local` and the password printed at the end of setup

### Updating production after a code change

```bash
cd ~/openwind
git pull
docker compose up -d --build ow-backend ow-frontend
```

Setup does not need to re-run for code updates — only for a full reset.

### Resetting production

```bash
docker compose down -v
(cd ../zitadel && docker compose down -v)
rm .env.local
# re-export the Step 3 env vars (or re-source .env.server), then:
./setup.sh
```

---

## What setup does — step by step

Understanding each step helps when something goes wrong. This is what
`setup.sh` / `setup.bat` actually run, in order:

| Step                    | What it does                                                                                                                                                              | Why                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Zitadel provisioning | Writes `../zitadel/docker-compose.yml` from a template, generates `ZITADEL_MASTERKEY` + admin password, starts Zitadel                                                    | Identity provider needs to exist and be healthy before anything else can register against it                                                                                               |
| 2. PAT generation       | Runs `scripts/gen-pat.mjs` in a throwaway container — automates the Zitadel login-form flow, creates a machine user, grants it `IAM_OWNER`, mints a Personal Access Token | Gives the bootstrap step a real admin-level token without a manual browser step                                                                                                            |
| 3. Infra start          | `docker compose up -d postgres pgbouncer redis`                                                                                                                           | Bootstrap needs the database and cache reachable                                                                                                                                           |
| 4. Bootstrap            | Runs `scripts/bootstrap.ts` inside the `bootstrap` container with `ZITADEL_SETUP_PAT` injected                                                                            | Applies migrations, configures the Zitadel OIDC app (project, roles, redirect URIs, introspection service account), seeds demo data and demo users, writes all credentials to `.env.local` |
| 5. App start            | `docker compose up -d --force-recreate ow-backend ow-frontend`                                                                                                            | Picks up the credentials bootstrap just wrote                                                                                                                                              |
| 6. Summary              | Prints Zitadel URL + admin login, OpenWind URL + demo logins                                                                                                              | Everything needed to log in, with nothing left to look up manually                                                                                                                         |

Bootstrap itself (step 4) is idempotent — safe to re-run against an existing
Zitadel/DB; it looks up existing projects/apps/users by name before creating
new ones.

---

## Services reference

### This repo's containers (`docker-compose.yml`)

| Container       | Internal port | Host port  | URL                                                              |
| --------------- | ------------- | ---------- | ---------------------------------------------------------------- |
| ow-database     | 5432          | —          | Internal only                                                    |
| ow-pgbouncer    | 5432          | 6432       | `localhost:6432`                                                 |
| ow-cache        | 6379          | —          | Internal only                                                    |
| ow-backend      | 3000          | —          | Internal only (proxied)                                          |
| ow-frontend     | 3001          | 3001       | `http://localhost:3001`                                          |
| ow-bootstrap    | —             | —          | One-shot, `profile: bootstrap`                                   |
| ow-secrets      | 8200          | 8200       | `http://localhost:8200`                                          |
| ow-secrets-init | —             | —          | One-shot, initializes OpenBao (idempotent — see below)           |
| ow-storage      | 9000, 9001    | 9000, 9001 | `http://localhost:9000` (API), `http://localhost:9001` (console) |
| ow-storage-init | —             | —          | One-shot, creates the `platform-files` bucket (idempotent)       |

OpenBao and MinIO start automatically with `docker compose up -d` — no profile
required, unlike the optional services below.

**OpenBao** (`@platform/secrets` backing store) runs in `-dev` mode: an
in-memory, non-persistent secrets engine meant for local development only.
Its root token is the hardcoded `dev-root-token` (see `docker-compose.yml`).
Because storage is in-memory, recreating the `openbao` container (not just
restarting it) wipes any secrets written during the session — expected in
dev, never a bug to chase.

`ow-secrets-init` runs `bao secrets enable transit` on every `docker compose
up`. On a second or later run that engine is already enabled from the first
run, so the command exits non-zero — the init script tolerates that specific
failure and still exits `0` (idempotency fix, PR #178, follow-up to #128/#173).
**If you see a "transit engine already enabled" message in
`ow-secrets-init`'s logs, that's expected — not a failure to debug.**

**MinIO** (`@platform/files` backing store) exposes the S3 API on `:9000` and
a web console on `:9001`. Dev credentials (hardcoded in `docker-compose.yml`):
`platform_access_key` / `platform_secret_key_dev_only`. `ow-storage-init` runs
`mc mb --ignore-existing` to create the `platform-files` bucket, so it's
already safe to re-run.

### The Zitadel compose project (`../zitadel/docker-compose.yml`)

Separate project, created and started by `setup.sh`/`setup.bat` — not part of
this repo's `docker compose up -d`.

| Container     | Internal port | Host port | URL                                         |
| ------------- | ------------- | --------- | ------------------------------------------- |
| zitadel       | 8080          | 8080      | `http://localhost:8080`                     |
| zitadel-db    | 5432          | —         | Internal only                               |
| ow-zita-setup | —             | —         | One-shot, `profile: setup` (PAT generation) |

### Optional services (this repo)

Start with `docker compose --profile <name> up -d`:

| Profile         | Services                                                              |
| --------------- | --------------------------------------------------------------------- |
| `notifications` | Novu API, worker, web UI, MongoDB                                     |
| `tools`         | MailHog (email trap port 8025), BullBoard (queue dashboard port 3099) |

### Image version pinning policy

Every non-core image in `docker-compose.yml` is pinned to a specific digest, not `:latest` —
a floating tag can silently change local-dev/CI behavior between one `docker compose up` and
the next with no corresponding commit to explain why something broke. Postgres and Redis were
already pinned to a tag (`postgres:16-alpine` / `redis:7-alpine`); the rest are pinned by digest
because most of these images don't publish a stable named version tag (`mailhog/mailhog` and
`deadly0/bull-board` have never published anything besides `:latest` on their registries).

**Bump policy: version bumps happen deliberately, in their own commit** — never silently
alongside an unrelated change. To bump one: `docker compose pull <service>`, resolve the new
digest with `docker inspect --format='{{index .RepoDigests 0}}' <image>:latest`, update the
`image:` line, and note why in the commit message.

**Known drift (not introduced by pinning, just made visible by it):** the three `novu-*` images
are not on a matched release line upstream — `novu-api`/`novu-worker`'s `:latest` were both built
2026-07-08, but `novu-web`'s hadn't moved since 2025-03-21 as of the pin date. Pinning captured
what was actually running rather than forcing an artificial sync; if Novu compatibility issues
ever surface, this is the first place to look.

---

## Environment variables reference

All variables are validated by Zod in `packages/config/src/env.ts`. The app
refuses to start if any required variable is missing or malformed.

| Variable                              | Written by        | Purpose                                                                         |
| ------------------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| `DATABASE_URL`                        | `.env.example`    | App connection via PgBouncer (transaction mode, required for RLS)               |
| `MIGRATION_DATABASE_URL`              | `.env.example`    | Direct Postgres for DDL — bypasses PgBouncer                                    |
| `ZITADEL_MASTERKEY`                   | `setup.sh`/`.ps1` | Zitadel's own encryption key — generated once, reused on re-run                 |
| `ZITADEL_ADMIN_PASSWORD`              | `setup.sh`/`.ps1` | Password for `owZitadelAdmin@openwind.local` — generated once, reused on re-run |
| `ZITADEL_ISSUER`                      | bootstrap         | OIDC issuer URL — must match JWT `iss` claim exactly                            |
| `ZITADEL_AUDIENCE`                    | bootstrap         | Project ID — must match JWT `aud` claim                                         |
| `ZITADEL_OIDC_CLIENT_ID`              | bootstrap         | Frontend OIDC client (public client, PKCE — no secret in normal operation)      |
| `ZITADEL_OIDC_CLIENT_SECRET`          | bootstrap         | Empty for the frontend app (registered as a public/PKCE client)                 |
| `ZITADEL_INTROSPECTION_CLIENT_ID`     | bootstrap         | Token introspection service account                                             |
| `ZITADEL_INTROSPECTION_CLIENT_SECRET` | bootstrap         | Token introspection secret                                                      |
| `ZITADEL_KEY_JSON`                    | bootstrap         | Base64 machine key for M2M API calls                                            |
| `VITE_ZITADEL_ISSUER`                 | bootstrap         | Same issuer, prefixed for Vite (browser-accessible)                             |
| `VITE_ZITADEL_OIDC_CLIENT_ID`         | bootstrap         | Same client ID for Vite                                                         |
| `ANTHROPIC_API_KEY`                   | manual            | AI features only — rest of platform works without it                            |

**Why two database URLs?**
`app_user` connects via PgBouncer in transaction mode, which is required for
`SET LOCAL app.tenant_id` RLS scoping to work. `migration_user` bypasses
PgBouncer and connects directly because DDL (CREATE TABLE, ALTER) cannot run
inside PgBouncer transaction mode. The two users have different privileges:
`app_user` is subject to RLS and has DML only; `migration_user` owns the schema.

---

## Database operations

### Migrations

```bash
pnpm db:migrate        # apply all pending migrations
```

Migrations live in `packages/db/migrations/` as numbered SQL files. Each runs
in a transaction. The journal at `packages/db/migrations/meta/_journal.json`
controls which files run — Drizzle reads it to determine pending migrations.

### Seeding

```bash
pnpm db:seed           # base tenant seed (idempotent)
pnpm seed:demo         # Helpdesk demo data — entity type, workflow, 5 tickets
```

Both run automatically as part of setup. Safe to re-run — all inserts use
`ON CONFLICT DO NOTHING`.

### Direct database access

```bash
docker compose exec ow-database psql -U platform -d platform

# Useful queries:
# All tenants
SELECT id, slug, status FROM tenants;

# Entity types for the dev tenant
SELECT name, slug FROM entity_types
WHERE tenant_id = '00000000-0000-0000-0000-000000000001';

# Applied migrations
SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at;
```

Zitadel's own database lives in the separate `zitadel-db` container (in
`../zitadel/`), not in `ow-database`:

```bash
(cd ../zitadel && docker compose exec zitadel-db psql -U zitadel -d zitadel)
```

---

## Troubleshooting

### Login fails: mixed content error in browser console

```
Mixed Content: The page at 'https://...' requested an insecure resource 'http://...'
```

**Cause:** Zitadel was initialised with `ZITADEL_EXTERNALSECURE=false` (or not
set). The issuer URL in its database is `http://` but the page is served over
HTTPS — browsers block HTTP requests from HTTPS pages.

**Fix:** Wipe Zitadel and reinitialise with `ZITADEL_EXTERNALSECURE=true` set
_before_ running setup again. See [Step 3](#step-3--set-the-deployment-env-vars)
in the production section.

```bash
export ZITADEL_EXTERNALSECURE=true   # plus the rest of Step 3's env vars
(cd ../zitadel && docker compose down -v)
rm .env.local
./setup.sh
```

### `docker compose restart` does not pick up new env values

`docker compose restart` and `docker restart` reuse the existing container —
they do NOT re-read `env_file` or `environment` changes. Always use:

```bash
docker compose up -d --force-recreate ow-backend ow-frontend
```

### Logged in fine, but every page is blank / `/api/*` requests return the HTML shell

Login (Zitadel) working while the app itself shows nothing, with API calls in
the browser's Network tab returning `200`/`304` and an HTML document instead of
JSON, means Vite's dev server is falling back to `index.html` for `/api/*` —
its proxy for `/api` isn't configured. `apps/admin-ui` always calls the
relative path `/api/...`, which only works if the `ow-frontend` container has
`VITE_API_PROXY_TARGET` set (see `docker-compose.yml`). Force-recreate it to
pick up the fix:

```bash
docker compose up -d --force-recreate ow-frontend
```

### All API requests return 401 after login

The API container has a stale `ZITADEL_AUDIENCE` (project ID) from before
setup wrote the real one. Force-recreate it:

```bash
docker compose up -d --force-recreate ow-backend
```

### Setup fails at "Starting Zitadel and generating bootstrap PAT"

Zitadel takes up to 90s on first boot (runs its own database initialisation).
Check logs from inside the Zitadel compose project:

```bash
cd ../zitadel && docker compose logs zitadel --tail=50
```

Common causes: a stale `zitadel_zitadel_db_data` volume left over from a
previous run with _different_ generated credentials (the script tries to
remove this automatically — if it can't, `docker volume rm
zitadel_zitadel_db_data` manually and re-run setup), or Postgres inside that
project not yet healthy.

### Setup fails at "Running OpenWind bootstrap"

The script prints the failing step's output above the error. Common cause:
`.env.local` from a previous run has stale `ZITADEL_*` credentials that no
longer match the (re-created) Zitadel instance — see
[Resetting everything](#resetting-everything).

### Migration fails: `permission denied for database platform`

`DATABASE_URL` uses `app_user`, which lacks DDL privileges. Migrations must use
`MIGRATION_DATABASE_URL`. Verify `.env.local`:

```
MIGRATION_DATABASE_URL=postgresql://migration_user:migration_user_dev_password@localhost:5432/platform
```

If missing, it is in `.env.example` — copy it manually or re-run setup.

### Port already in use

```bash
# macOS/Linux
lsof -i :3001
# Windows PowerShell
netstat -ano | findstr :3001
```

Change the conflicting host port: `ADMIN_UI_HOST_PORT` / `ZITADEL_HOST_PORT`
env vars for the frontend/Zitadel ports (see the production section), or edit
`docker-compose.yml` directly for the others.

### Platform-specific notes

**macOS (Apple Silicon):** All images use multi-arch variants. If you see
`exec format error`, ensure Docker Desktop uses the Apple Silicon VM (not Rosetta).

**Linux:** Ensure your user is in the `docker` group:

```bash
sudo usermod -aG docker $USER && newgrp docker
```

**Windows:** Run `setup.bat` from PowerShell, CMD, or by double-clicking it —
it delegates to `scripts/setup.ps1` internally. Docker Desktop must be
running. No WSL2 or Git Bash required for setup itself (Git Bash is only
needed if you want to run `setup.sh` instead).
