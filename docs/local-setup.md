# OpenWind Setup Guide

This guide covers everything needed to run OpenWind locally for development and
to deploy it to a production server with HTTPS. Read the section that applies to
your goal.

---

## Table of contents

- [Local development](#local-development)
- [Production deployment (HTTPS)](#production-deployment-https)
- [What bootstrap does — step by step](#what-bootstrap-does--step-by-step)
- [Services reference](#services-reference)
- [Environment variables reference](#environment-variables-reference)
- [Database operations](#database-operations)
- [Troubleshooting](#troubleshooting)

---

## Local development

### Prerequisites

| Tool    | Minimum version | Install                            |
| ------- | --------------- | ---------------------------------- |
| Node.js | 22              | https://nodejs.org                 |
| pnpm    | 9               | `npm install -g pnpm`              |
| Docker  | 24              | https://docs.docker.com/get-docker |

### First-time setup

```bash
# 1. Clone and install dependencies
git clone <repo-url> openwind
cd openwind
pnpm install

# 2. Start infrastructure + run bootstrap (one command)
pnpm bootstrap
# OR inside Docker (same result):
docker compose --profile bootstrap run --rm bootstrap
```

Bootstrap will:

- Start all Docker services (Postgres, Redis, Zitadel, API, frontend)
- Run database migrations
- Configure Zitadel (project, OIDC app, roles, service account)
- Create demo users
- Write all generated credentials to `.env.local`
- Restart the API and frontend containers so they pick up the new credentials

**When it finishes** you will see login credentials and URLs printed to the terminal.
Open `http://localhost:3001` and log in with `owAdmin` / `OpenWind1234!`.

### Resetting everything

```bash
docker compose down -v   # stop containers and wipe all volumes (data gone)
rm .env.local            # remove generated credentials
pnpm bootstrap           # full setup again from scratch
```

> Always use `-v` before re-bootstrapping. Without it the old Postgres/Zitadel
> data persists and the new Zitadel setup collides with it.

### Day-to-day commands

```bash
pnpm dev                               # start API + frontend with hot reload (outside Docker)
docker compose up -d                   # start all services in Docker
docker compose down                    # stop (data preserved)
docker compose logs -f ow-backend      # tail API logs
docker compose restart ow-frontend     # restart one container
```

---

## Production deployment (HTTPS)

Production differs from local in one critical way: **Zitadel must know it is
running behind HTTPS before its very first boot.** Zitadel bakes the issuer URL
into its database during `start-from-init`. If it initialises with `http://`, the
issuer is permanently `http://` until you wipe the database and start again.
Getting this wrong means the browser blocks all auth requests (mixed content) and
login never works.

Follow these steps in order.

### Step 1 — Prerequisites on the server

- Docker and Docker Compose (v2) installed
- A reverse proxy (nginx, Caddy, Traefik) handling SSL termination and forwarding
  traffic to the container ports
- Two subdomains with valid HTTPS certificates:
  - `openwind.example.com` → forwards to host port for the frontend container
  - `owzitadel.example.com` → forwards to host port for the Zitadel container

### Step 2 — Clone the repo

```bash
git clone <repo-url> ~/openwind
cd ~/openwind
```

### Step 3 — Create the override file

Docker Compose automatically merges `docker-compose.override.yml` with the base
`docker-compose.yml`. The override holds all server-specific config that must
never go into git (real domain names, non-default ports, HTTPS flags).

Create `~/openwind/docker-compose.override.yml`:

```yaml
services:
  zitadel:
    # Keep restart enabled after initial setup is complete.
    # During the very first init, if Zitadel crashes it will restart and attempt
    # to re-init, which can cause duplicate key errors. Once bootstrap has
    # finished successfully this is safe to leave as unless-stopped.
    restart: unless-stopped
    command: start-from-init --masterkey "${ZITADEL_MASTERKEY}" --tlsMode disabled
    ports:
      - "10405:8080" # host port 10405 → Zitadel container port 8080
    environment:
      # CRITICAL: set these BEFORE the first boot.
      # Zitadel writes the issuer URL into its database during start-from-init.
      # If EXTERNALSECURE is false here, the issuer becomes http:// permanently
      # until you wipe the database and restart.
      ZITADEL_EXTERNALDOMAIN: owzitadel.example.com
      ZITADEL_EXTERNALPORT: 443
      ZITADEL_EXTERNALSECURE: "true"
    networks:
      default:
        # Docker-internal alias so containers can reach Zitadel by its public
        # hostname without leaving the Docker network.
        aliases:
          - owzitadel.example.com

  ow-backend:
    environment:
      # Backend reaches Zitadel via internal Docker network (HTTP is fine here —
      # TLS termination happens at the reverse proxy, not inside Docker).
      ZITADEL_JWKS_URL: http://owzitadel.example.com:8080/oauth/v2/keys
      ZITADEL_INTROSPECTION_URL: http://owzitadel.example.com:8080/oauth/v2/introspect
      # ZITADEL_ISSUER must match the JWT iss claim, which is the HTTPS external URL.
      ZITADEL_ISSUER: https://owzitadel.example.com
      CORS_ORIGIN: https://openwind.example.com

  ow-frontend:
    ports:
      - "10404:3001" # host port 10404 → frontend container port 3001

  postgres:
    ports:
      - "54320:5432" # expose Postgres for direct access if needed
```

Replace `owzitadel.example.com` and `openwind.example.com` with your real domains.
Choose host ports (`10404`, `10405`) that are free on your server.

**Why `ZITADEL_EXTERNALSECURE: "true"` matters:**  
Zitadel's `start-from-init` reads these three vars and writes the instance issuer
URL as `{scheme}://{EXTERNALDOMAIN}` into its database. With `EXTERNALSECURE=true`
the scheme is `https://`. With it absent or false the scheme is `http://`, and
browsers running on an HTTPS page will block every auth request (mixed content
error). There is no migration path — you must wipe and reinit if you get this wrong.

### Step 4 — Set the compose env vars

Create `~/openwind/.env` (Docker Compose reads this automatically for `${}` variable
substitution in the YAML — separate from `.env.local` which holds app secrets):

```bash
ZITADEL_EXTERNAL_DOMAIN=owzitadel.example.com
ZITADEL_HOST_PORT=10405
ZITADEL_EXTERNALSECURE=true
```

This makes the bootstrap container aware of these values so it generates HTTPS
URLs when writing to `.env.local`.

### Step 5 — Run bootstrap

```bash
cd ~/openwind
docker compose --profile bootstrap run --rm bootstrap
```

Bootstrap will start all services, wait for Zitadel to initialise (up to 90s on
first boot), configure everything, and print a summary with login credentials.

After bootstrap finishes, restart the app containers to load the written credentials:

```bash
docker compose restart ow-backend ow-frontend
```

### Step 6 — Fix Zitadel console redirect URIs (one-time, after first init)

Zitadel's console UI has a built-in OIDC app whose redirect URIs are written
during `start-from-init`. Due to a Zitadel quirk, these are sometimes stored
as `http://...:443` instead of `https://`. Fix them once after the first boot:

```bash
# Find the console app ID
docker exec ow-database psql -U platform -d zitadel -c \
  "SELECT app_id, client_id FROM projections.apps7_oidc_configs;"

# Update redirect URIs (replace APP_ID with the console app's id from above)
docker exec ow-database psql -U platform -d zitadel -c "
UPDATE projections.apps7_oidc_configs
SET
  redirect_uris = '{https://owzitadel.example.com/ui/console/auth/callback}',
  post_logout_redirect_uris = '{https://owzitadel.example.com/ui/console/signedout}'
WHERE app_id = 'APP_ID';
"
```

You only need to do this once. After this the Zitadel console at
`https://owzitadel.example.com/ui/console` will work.

### Step 7 — Verify

- App: `https://openwind.example.com` → log in with `owAdmin` / `OpenWind1234!`
- Zitadel console: `https://owzitadel.example.com/ui/console` → log in with
  `owZitadelAdmin@openwind.local` / `Admin1234!`

### Updating production after a code change

```bash
cd ~/openwind
git pull
docker compose up -d --build ow-backend ow-frontend
```

Bootstrap does not need to re-run for code updates — only for a full reset.

### Resetting production

```bash
docker compose stop zitadel
docker exec ow-database psql -U platform -c "DROP DATABASE IF EXISTS zitadel;"
docker compose down -v
rm .env.local
docker compose --profile bootstrap run --rm bootstrap
docker compose restart ow-backend ow-frontend
# Then repeat Step 6 (redirect URI fix)
```

> Stop Zitadel before dropping its database — Postgres will refuse the DROP
> while active sessions exist.

---

## What bootstrap does — step by step

Understanding each step helps when something goes wrong.

| Step                | What it does                                                                                   | Why                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1. Prerequisites    | Checks Node 22+, pnpm, Docker (skipped in Docker mode)                                         | Fast-fail before any side effects                                                                               |
| 2. Environment      | Copies `.env.example` → `.env.local` if missing                                                | Ensures the file exists for subsequent writes                                                                   |
| 3. Start services   | Runs `docker compose up -d` (skipped in Docker mode)                                           | Brings up Postgres, Redis, Zitadel                                                                              |
| 4. Health checks    | Polls pgbouncer and Zitadel until healthy (up to 90s)                                          | Zitadel runs `initdb` equivalent on first boot — slow                                                           |
| 5. Dependencies     | `pnpm install` + builds `@platform/config` and `@platform/db`                                  | Scripts import these packages at runtime                                                                        |
| 6. Migrations       | Runs all SQL migrations via Drizzle                                                            | Creates the schema, RLS policies, indexes                                                                       |
| 7. Zitadel setup    | Creates: project `OpenWind`, OIDC app, introspection SA, roles (admin/agent/user), machine key | Establishes the identity layer; writes `ZITADEL_ISSUER`, `ZITADEL_AUDIENCE`, client credentials to `.env.local` |
| 8. Demo users       | Creates `owAdmin`, `owUser`, `testUser1–5` in Zitadel                                          | Ready-to-use logins for development                                                                             |
| 9. Module templates | Auto-seeds on first visit to Templates page                                                    | No action needed at bootstrap time                                                                              |
| 10. Summary         | Prints all URLs and credentials                                                                | Reference for what was created                                                                                  |

**How bootstrap authenticates with Zitadel (headless machine key flow):**

1. Zitadel writes a machine key JSON file to a shared Docker volume
   (`zitadel_machinekey`) on first boot via `ZITADEL_FIRSTINSTANCE_MACHINEKEYPATH`.
2. Bootstrap reads that file from the volume mount (`/zitadel-machinekey/`).
3. Bootstrap discovers the exact issuer URL from
   `/.well-known/openid-configuration` (important: the issuer in the JWT `aud`
   claim must match exactly what Zitadel considers its own URL).
4. Bootstrap signs a JWT with the machine key and exchanges it for an access token
   using the `urn:ietf:params:oauth:grant-type:jwt-bearer` grant.
5. All subsequent Zitadel API calls use that token. No browser PAT step required.

---

## Services reference

### Local ports (default)

| Container    | Internal port | Host port | URL                     |
| ------------ | ------------- | --------- | ----------------------- |
| ow-database  | 5432          | —         | Internal only           |
| ow-pgbouncer | 5432          | 6432      | `localhost:6432`        |
| ow-cache     | 6379          | —         | Internal only           |
| ow-identity  | 8080          | 8080      | `http://localhost:8080` |
| ow-backend   | 3000          | —         | Internal only (proxied) |
| ow-frontend  | 3001          | 3001      | `http://localhost:3001` |

### Optional services

Start with `docker compose --profile <name> up -d`:

| Profile         | Services                                                              |
| --------------- | --------------------------------------------------------------------- |
| `notifications` | Novu API, worker, web UI, MongoDB                                     |
| `tools`         | MailHog (email trap port 8025), BullBoard (queue dashboard port 3099) |

---

## Environment variables reference

All variables are validated by Zod in `packages/config/src/env.ts`. The app
refuses to start if any required variable is missing or malformed.

| Variable                              | Written by     | Purpose                                                           |
| ------------------------------------- | -------------- | ----------------------------------------------------------------- |
| `DATABASE_URL`                        | `.env.example` | App connection via PgBouncer (transaction mode, required for RLS) |
| `MIGRATION_DATABASE_URL`              | `.env.example` | Direct Postgres for DDL — bypasses PgBouncer                      |
| `ZITADEL_ISSUER`                      | bootstrap      | OIDC issuer URL — must match JWT `iss` claim exactly              |
| `ZITADEL_AUDIENCE`                    | bootstrap      | Project ID — must match JWT `aud` claim                           |
| `ZITADEL_OIDC_CLIENT_ID`              | bootstrap      | Frontend OIDC client                                              |
| `ZITADEL_OIDC_CLIENT_SECRET`          | bootstrap      | Frontend OIDC secret                                              |
| `ZITADEL_INTROSPECTION_CLIENT_ID`     | bootstrap      | Token introspection service account                               |
| `ZITADEL_INTROSPECTION_CLIENT_SECRET` | bootstrap      | Token introspection secret                                        |
| `ZITADEL_KEY_JSON`                    | bootstrap      | Base64 machine key for M2M API calls                              |
| `VITE_ZITADEL_ISSUER`                 | bootstrap      | Same issuer, prefixed for Vite (browser-accessible)               |
| `VITE_ZITADEL_OIDC_CLIENT_ID`         | bootstrap      | Same client ID for Vite                                           |
| `ANTHROPIC_API_KEY`                   | manual         | AI features only — rest of platform works without it              |

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

Both run automatically in bootstrap. Safe to re-run — all inserts use
`ON CONFLICT DO NOTHING`.

### Direct database access

```bash
docker compose exec postgres psql -U platform -d platform

# Useful queries:
# All tenants
SELECT id, slug, status FROM tenants;

# Entity types for the dev tenant
SELECT name, slug FROM entity_types
WHERE tenant_id = '00000000-0000-0000-0000-000000000001';

# Applied migrations
SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at;
```

---

## Troubleshooting

### Login fails: mixed content error in browser console

```
Mixed Content: The page at 'https://...' requested an insecure resource 'http://...'
```

**Cause:** Zitadel was initialised with `EXTERNALSECURE=false` (or not set).
The issuer URL in the database is `http://` but the page is served over HTTPS.
Browsers block HTTP requests from HTTPS pages.

**Fix:** Wipe Zitadel's database and reinitialise with `EXTERNALSECURE=true` set
in `docker-compose.override.yml` _before_ starting. See [Step 3](#step-3--create-the-override-file).

```bash
docker compose stop zitadel
docker exec ow-database psql -U platform -c "DROP DATABASE IF EXISTS zitadel;"
# Ensure override has ZITADEL_EXTERNALSECURE: "true", then:
docker compose up -d --force-recreate zitadel
# Wait ~90s, then run bootstrap again
```

### Login fails: `Errors.App.NotFound`

The Zitadel console's OIDC app client_id in `environment.json` does not match
the app registered in the database. This happens when the database is wiped and
Zitadel regenerates IDs.

```bash
# Find what client_id is in environment.json
curl -sk https://owzitadel.example.com/ui/console/assets/environment.json

# Find what client_id is in the database
docker exec ow-database psql -U platform -d zitadel -c \
  "SELECT a.id, a.name, oc.client_id FROM projections.apps7 a
   JOIN projections.apps7_oidc_configs oc ON a.id = oc.app_id;"

# Update the DB to match environment.json (replace CLIENT_ID_FROM_ENV_JSON and APP_ID)
docker exec ow-database psql -U platform -d zitadel -c "
UPDATE projections.apps7_oidc_configs
SET client_id = 'CLIENT_ID_FROM_ENV_JSON'
WHERE app_id = 'APP_ID';

UPDATE eventstore.unique_constraints
SET unique_field = 'CLIENT_ID_FROM_ENV_JSON'
WHERE unique_field = 'OLD_CLIENT_ID_FROM_DB';
"
```

### Zitadel console: redirect_uri mismatch

```
The requested redirect_uri is missing in the client configuration.
```

The console app's redirect URIs are stored as `http://...:443` instead of `https://`.
Fix: see [Step 6](#step-6--fix-zitadel-console-redirect-uris-one-time-after-first-init).

### `docker compose restart` does not pick up new env values

`docker compose restart` and `docker restart` reuse the existing container — they
do NOT re-read `env_file` or `environment` changes. Always use:

```bash
docker compose up -d --force-recreate ow-backend ow-frontend
```

### All API requests return 401 after login

The API container has a stale `ZITADEL_AUDIENCE` (project ID) from before
bootstrap wrote the real one. Force-recreate it:

```bash
docker compose up -d --force-recreate ow-backend
```

### DROP DATABASE fails: "being accessed by other users"

Stop the Zitadel container first to close its connections:

```bash
docker compose stop zitadel
docker exec ow-database psql -U platform -c "DROP DATABASE IF EXISTS zitadel;"
```

### Bootstrap fails: cannot connect to Zitadel

Zitadel takes up to 90s on first boot (runs its own database initialisation).
Bootstrap waits up to 90s automatically. If it still fails, check logs:

```bash
docker compose logs ow-identity --tail=50
```

Common causes: wrong Postgres credentials in the Zitadel environment block, or
Postgres itself not yet healthy.

### Migration fails: `permission denied for database platform`

`DATABASE_URL` uses `app_user` which lacks DDL privileges. Migrations must use
`MIGRATION_DATABASE_URL`. Verify `.env.local`:

```
MIGRATION_DATABASE_URL=postgresql://migration_user:migration_user_dev_password@localhost:5432/platform
```

If missing, it is in `.env.example` — copy it manually or re-run bootstrap.

### Port already in use

```bash
# macOS/Linux
lsof -i :3001
# Windows PowerShell
netstat -ano | findstr :3001
```

Change the conflicting host port in `docker-compose.yml` (left-hand side of the
`ports:` entry). For production, set the host port in `docker-compose.override.yml`.

### Platform-specific notes

**macOS (Apple Silicon):** All images use multi-arch variants. If you see
`exec format error`, ensure Docker Desktop uses the Apple Silicon VM (not Rosetta).

**Linux:** Ensure your user is in the `docker` group:

```bash
sudo usermod -aG docker $USER && newgrp docker
```

**Windows:** Run from PowerShell or Git Bash. Docker Desktop must be running.
No WSL2 required — everything runs inside Docker containers.
