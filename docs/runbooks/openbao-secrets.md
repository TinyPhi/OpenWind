# OpenBao secrets runbook (production)

How to run OpenWind in production with its secrets in OpenBao: first-time setup, moving a running
instance over, rollback, reboots, rotation, and troubleshooting. The design is
[ADR-023](../decisions/ADR-023-openbao-secrets-manager.md); this page is the "how". Local
development does not use any of this — see [local setup](../local-setup.md).

Owner: Bikash (@bikash-barnwal), per ADR-023 Consequences.

## Before you start

### What lands where

Several pieces this runbook uses are added by separate pull requests under #911. Until a piece is
merged, the step that uses it can't be run yet.

| Piece                                                                                                                | Added by |
| -------------------------------------------------------------------------------------------------------------------- | -------- |
| `@platform/secrets` hardening; production guards; `.env.local` not loaded in production; `db:check-local-ciphertext` | PR 1     |
| Bootstrap production mode (`BOOTSTRAP_SECRETS_OUT`, `--rotate-introspection-secret`); `pnpm credential:set`          | PR 2     |
| Startup loaders `packages/openbao-deploy/src/bao-env-loader.mjs` (Node) and `bao-env-loader.py` (Superset)           | PR 3     |
| `docker-compose.prod.yml`, `.env.production.example`, `pnpm --filter @platform/openbao-deploy check:prod-compose`    | PR 4     |

Some steps also need changes in the **separate OpenBao operations repository**, which runs the
OpenBao server. They are marked **[ops repo]**. This page does not describe that server's
internals; ask its owner.

### Words used here

- **Role**: one OpenBao AppRole per OpenWind service. A role has a **role ID** (like a user name)
  and a **secret ID** (like a password).
- **Role file**: a small file on the server holding one service's `OPENBAO_ROLE_ID` and
  `OPENBAO_SECRET_ID`. Mode `0600`, never in git.
- **KV path**: where a service's secrets live in OpenBao: `secret/openwind/<env>/<service>`.
- **Loader**: the program that runs first in each secret-holding container. It logs in, reads the
  service's KV path once, then starts the real app with those values.

### The production model in one table

| Service                       | KV path                               | Role file           |
| ----------------------------- | ------------------------------------- | ------------------- |
| `ow-backend`                  | `secret/openwind/<env>/backend`       | `backend.env`       |
| `ow-worker`                   | `secret/openwind/<env>/worker`        | `worker.env`        |
| `superset`                    | `secret/openwind/<env>/superset`      | `superset.env`      |
| `superset-init` (one-shot)    | `secret/openwind/<env>/superset-init` | `superset-init.env` |
| `bootstrap` (one-shot)        | `secret/openwind/<env>/bootstrap`     | `bootstrap.env`     |
| `novu-api`, `novu-worker`     | `secret/openwind/<env>/novu`          | `novu.env`          |
| `ow-frontend`                 | **none** — public values only         | —                   |
| `pgbouncer` (exception, OQ-3) | **none** — not on OpenBao yet         | `pgbouncer.env`     |

`<env>` is `OPENWIND_BAO_ENV` (default `prod`). `pgbouncer.env` holds `DB_PASSWORD` only, because
the pgbouncer image has no Node or Python to run a loader.

### Files on the server

All of these live **outside the repository checkout**, so a `git pull` or a fresh clone never
touches them.

- **Role files** in `OPENWIND_SECRETS_DIR`, one per row above, each mode `0600`, owned by the
  deploy user.
- **`postgres.env`** in the same directory, with `POSTGRES_PASSWORD=...`. Postgres reads it only
  when its data volume is first created.
- **A bootstrap output directory** (`OPENWIND_BOOTSTRAP_OUT_DIR`, mode `0700`), where bootstrap
  writes any new secrets as a `0600` file for you to load into OpenBao and delete.
- **The non-secret `.env`** in the checkout root (it is gitignored). It holds wiring only, never a
  secret. Every variable is documented in `.env.production.example` (PR 4): `OPENWIND_SECRETS_DIR`,
  `OPENWIND_BOOTSTRAP_OUT_DIR`, `OPENBAO_ADDR`, `OPENBAO_NETWORK`, `OPENBAO_NETWORK_CIDR`, the
  fixed per-service addresses (`OW_BAO_IP_BACKEND`, `_WORKER`, `_SUPERSET`, `_SUPERSET_INIT`,
  `_BOOTSTRAP`, `_NOVU_API`, `_NOVU_WORKER`), `OPENWIND_BAO_ENV`, `OPENBAO_TRANSIT_KEY`,
  `COMPOSE_PROFILES` and the public URLs.
- **No `.env.local`.** Production does not read it (PR 1). After cutover it is removed.

All production commands use the production override. To keep them short, this page uses:

```bash
DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
$DC up -d
```

**Never start production without `-f docker-compose.prod.yml`.** Without it, the dev OpenBao (root
token `dev-root-token`, published in this repo) starts, and services read dev wiring.

### Commands that touch OpenBao directly

`bao ...` commands below run on a machine that can reach OpenBao, with a token from the operations
repo that may write OpenWind's KV paths and manage its roles. `openbao.example.com` stands for your
server's name. Two habits keep values out of shell history and screen recordings:

- Pass a value on stdin with `KEY=-`, or from a `0600` file with `@file.json`.
- Run `umask 077` first in any shell that writes secret files.

## First-time setup

For a new deployment with no running instance. To move an existing one, see
[Cutover](#cutover-from-a-running-instance) instead.

1. **Network and roles — [ops repo].** Ask the OpenBao owner to:
   - create the per-project network (`OPENBAO_NETWORK`, default `openbao-openwind`) and give OpenBao
     a network alias matching its certificate name;
   - onboard one role per row in the table above, bound to that network's addresses
     (`secret_id_bound_cidrs`, `token_bound_cidrs`), each with a policy for **its own KV path
     only**;
   - give backend and worker **decrypt-only** on the Transit key (encrypt is added only when a
     credential write path needs it, ADR-023 Decision 8);
   - set a finite `secret_id_ttl` (for example 30 days), `secret_id_num_uses=0`, and short token
     TTLs (ADR-023 Decision 5a).

2. **Transit key — [ops repo].** One key per environment, `derived=true`, `exportable=false`,
   `allow_plaintext_backup=false`, `deletion_allowed=false`. Put its name in `.env` as
   `OPENBAO_TRANSIT_KEY`.

3. **Role files.** For each role, write its role file:

   ```bash
   umask 077
   mkdir -p "$OPENWIND_SECRETS_DIR"
   ROLE=<role-name-for-backend>      # from the ops repo onboarding
   {
     echo "OPENBAO_ROLE_ID=$(bao read -field=role_id auth/approle/role/$ROLE/role-id)"
     echo "OPENBAO_SECRET_ID=$(bao write -f -field=secret_id auth/approle/role/$ROLE/secret-id)"
   } > "$OPENWIND_SECRETS_DIR/backend.env"
   chmod 0600 "$OPENWIND_SECRETS_DIR/backend.env"
   ```

   Repeat for `worker`, `superset`, `superset-init`, `bootstrap` and `novu`. Write
   `pgbouncer.env` by hand with one line, `DB_PASSWORD=...` (the `app_user` password), and
   `postgres.env` with `POSTGRES_PASSWORD=...` (the superuser password).

4. **KV values.** For each service, write its values to a JSON file in a private (mode `0700`)
   working directory, load it, and delete the whole directory:

   ```bash
   umask 077
   W=$(mktemp -d)                              # mode 0700
   vi -n -i NONE "$W/backend.json"             # no swap or backup copies; {"DATABASE_URL": "...", ...}
   bao kv put -mount=secret openwind/prod/backend @"$W/backend.json"
   shred -u "$W/backend.json"; rm -rf "$W"
   bao kv get -mount=secret -format=json openwind/prod/backend | jq '.data.data | keys'
   ```

   **`kv put` vs `kv patch`:** `kv put` writes a new version that holds **only** the keys you give
   it, so any other key at that path disappears (KV v2 keeps the old version, so `bao kv rollback`
   can undo it). Use `kv put` only for the first write to an empty path. Whenever a path may
   already hold keys, add or change keys with `kv patch` instead, which keeps the rest:

   ```bash
   printf '%s' "$VALUE" | bao kv patch -mount=secret openwind/prod/backend SOME_KEY=-
   ```

   The `kv get` line prints key **names** only. Which keys each service needs is the `BAO_REQUIRED_KEYS`
   list the production override sets for it (PR 4). Rules that are easy to miss:
   - A value two services need is stored **at both paths** (no wildcards). For example
     `REPORTING_BINDING_SECRET` goes in `superset` and in `bootstrap` (the migration runner writes the
     database's copy).
   - `MIGRATION_DATABASE_URL` goes **only** in `bootstrap`, never in `worker` (ADR-001).
   - Superset secrets go only where they are used: `backend` holds just
     `SUPERSET_SERVICE_ACCOUNT_PASSWORD`, and `worker` holds none. Production has no development
     defaults for them (PR 1), so nothing else needs them.
   - Do not put a key in KV that compose also sets non-empty: the loader refuses to start (exit 78).
   - `METRICS_TOKEN` must be a real value; production refuses the dev default (PR 1).

5. **Non-secret `.env`.** Copy `.env.production.example` (PR 4) to `.env` and fill it in.

6. **Check the rendered config** before the first start:

   ```bash
   pnpm --filter @platform/openbao-deploy check:prod-compose
   ```

   It fails if the production config would start the dev OpenBao, mount `.env.local`, or set a
   non-allowlisted `environment:` key (PR 4).

7. **Database passwords, before any app starts.** `docker/postgres/init/001_setup.sql` creates
   `app_user`, `migration_user`, `analytics_user` and `superset_user` with passwords that are
   published in this repo, and the `platform` superuser gets whatever `postgres.env` held when the
   volume was created. Start **only** Postgres, rotate every role, then store the new values:

   ```bash
   umask 077
   $DC up -d postgres                          # first start creates the roles
   W=$(mktemp -d)                              # mode 0700
   vi -n -i NONE "$W/rotate.sql"
   #   ALTER ROLE app_user       PASSWORD '...';
   #   ALTER ROLE migration_user PASSWORD '...';
   #   ALTER ROLE analytics_user PASSWORD '...';
   #   ALTER ROLE superset_user  PASSWORD '...';
   #   ALTER ROLE platform       PASSWORD '...';   -- superuser
   $DC exec -T postgres psql -v ON_ERROR_STOP=1 -U platform -d platform < "$W/rotate.sql"
   shred -u "$W/rotate.sql"; rm -rf "$W"
   ```

   Then put the new passwords everywhere they are used, before step 8:
   - **OpenBao KV** (with `kv patch`): every URL that embeds a password: `DATABASE_URL` and
     `DATABASE_DIRECT_URL` (backend, worker), `DATABASE_URL` and `MIGRATION_DATABASE_URL`
     (bootstrap), the Superset `DATABASE_URL` (superset, superset-init),
     `SUPERSET_REPORTING_DB_URI` (superset-init);
   - **`pgbouncer.env`**: `DB_PASSWORD` = the new `app_user` password;
   - **`postgres.env`**: `POSTGRES_PASSWORD` = the new `platform` password (only read when a new
     volume is created, but keep it in step).

   Never start the apps while any role still has its committed password.

8. **Bootstrap.** Bootstrap in production never writes `.env.local`. New secrets it creates go to a
   file named by `BOOTSTRAP_SECRETS_OUT`, which must not exist yet; without it, bootstrap refuses
   before rotating anything (PR 2). It also stops before any change unless it has Zitadel
   credentials: `ZITADEL_KEY_JSON` in its KV path, or, on the very first run only, a one-time
   `ZITADEL_SETUP_PAT`:

   ```bash
   read -rs ZITADEL_SETUP_PAT && export ZITADEL_SETUP_PAT   # first run only; not echoed
   $DC --profile bootstrap run --rm -e ZITADEL_SETUP_PAT bootstrap
   unset ZITADEL_SETUP_PAT
   ```

   Load what it wrote into the right KV paths with **`kv patch`** (step 4; never `kv put`, which
   would drop the keys already there), then `shred -u` the file. Bootstrap's key names map to the
   service paths that use them (for example `ZITADEL_INTROSPECTION_CLIENT_SECRET` → `backend` and
   `worker`; `ZITADEL_KEY_JSON` → `bootstrap` too, so later runs need no PAT).

9. **Start and check:**

   ```bash
   $DC up -d
   $DC ps
   $DC logs ow-backend | grep '\[bao-env\]'
   ```

   A good start logs `applied <n> keys from secret/openwind/prod/backend (values never logged)`.

## Cutover from a running instance

Moving an instance that today reads `.env.local` and the committed `.env`. Do it in a maintenance
window, and rehearse it (including the [rollback](#rollback)) on a copy first.

### 1. Inventory

- List every key in the server's `.env.local` and in any compose `environment:` entry, and note
  which service reads it. Record **names only**.
- Count connector credentials still encrypted with the published `local:` key:

  ```bash
  MIGRATION_DATABASE_URL=... pnpm --filter @platform/db db:check-local-ciphertext
  ```

  It needs a live database connection: point `MIGRATION_DATABASE_URL` at the production database
  (or a read replica) from a host that can reach it, not at a laptop checkout. It only counts,
  in a read-only transaction, and prints counts, never values.

  It is read-only and prints counts only. It **must report zero** before production runs with the
  new guards (PR 1), because production refuses to decrypt `local:` values. If it reports any,
  re-enter those credentials through the write path first:

  ```bash
  pnpm credential:set --tenant <tenant-uuid> --connector <connector-id> --key <name>   # value on stdin (PR 2)
  ```

  In production there is no `.env.local`: the script's `dotenv -e .env.local` wrapper simply
  finds no file and runs the script with the environment you exported. Run it from a checkout on a
  host that reaches the database and OpenBao, with `DATABASE_URL`, `NODE_ENV=production` and
  OpenBao AppRole settings for a role that may **encrypt** with the Transit key (ADR-023
  Decision 8). Pass secrets in the environment or on stdin, never on the command line.

### 2. Rotate cheap, published secrets — before cutover

These values are published in this repository, so copying them into OpenBao would protect nothing.
Rotate each one, then load the **new** value into OpenBao:

- **Postgres role passwords** (`app_user`, `migration_user`, `analytics_user`, `superset_user`, and
  the `platform` superuser): `ALTER ROLE ... PASSWORD '...'`, then update every URL that embeds
  them, and the copy in `pgbouncer.env` (`app_user`).
- **Novu `JWT_SECRET`**: new random value. Existing Novu sessions end.
- **Superset service-account and admin passwords** (`SUPERSET_SERVICE_ACCOUNT_PASSWORD`,
  `SUPERSET_ADMIN_PASSWORD`).
- **`REPORTING_BINDING_SECRET`** (at least 32 characters): store it at both the `superset` and
  `bootstrap` paths, re-run the migrations (the `bootstrap` one-shot does this; it rewrites the
  database's copy), then restart Superset. Between those two steps reporting shows no data — that
  is the designed fail-closed behaviour, not an outage to chase.
- **`METRICS_TOKEN`**: new random value. Also change the scrape credential on your Prometheus; the
  repository's `docker/observability/prometheus.yml` still contains the dev token.
- **Grafana admin password** (`GRAFANA_ADMIN_PASSWORD`), if the `observability` profile runs.

### 3. Copy, don't regenerate, keys that protect stored data

Regenerating these would make stored data unreadable. Copy the current values into OpenBao as they
are, and give each a **dated** rotation plan. Until rotated, they are not considered secret
(ADR-023 Decision 6).

| Key                                             | Protects                                  | Rotation plan                                                                                                                                                                                            |
| ----------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPERSET_SECRET_KEY` (Superset's `SECRET_KEY`) | The reporting DB password Superset stores | Run `superset re-encrypt-secrets` with the old key as Superset's `PREVIOUS_SECRET_KEY` and the new one as current. `superset_config.py` does not read a previous key today; that is a small change first |
| Novu `STORE_ENCRYPTION_KEY`                     | Saved notification provider credentials   | Set the new key, then re-enter each Novu integration's credentials                                                                                                                                       |

### 4. Load, switch, verify

**Blocking checklist, before you switch:**

- [ ] The rollback override (`docker-compose.rollback.yml`, #970) is merged and has been
      **rehearsed** on a copy: every service started from its rollback file, with the loader off
      (see [Rollback](#rollback)).
- [ ] Prometheus's scrape credential for the API and worker `/metrics` is the **production**
      `METRICS_TOKEN`, not the dev token in `docker/observability/prometheus.yml`. Otherwise metrics
      stop when the production guard refuses the dev token.
- [ ] `db:check-local-ciphertext` reported zero (step 1).
- [ ] `check:prod-compose` passes with the server's `COMPOSE_PROFILES`.
- [ ] An OpenBao restore, and a joint database + OpenBao restore, have been tested.

1. Do [first-time setup](#first-time-setup) steps 1–6 with the values from steps 1–3.
2. Stop the old stack, start with the override: `$DC up -d`.
3. Check every secret-holding service logged `applied <n> keys`, and click through: sign-in, a
   ticket, a report, a notification.
4. Once verified, remove `.env.local` from the server (`shred -u .env.local`).

## Rollback

Use this only if the cutover fails and can't be fixed forward. Rehearse it before the real
cutover.

1. As the runbook owner, export each service's values into a one-time file:

   ```bash
   umask 077
   bao kv get -mount=secret -format=json openwind/prod/backend \
     | jq -r '.data.data | to_entries[] | "\(.key)=\(.value)"' \
     > "$OPENWIND_SECRETS_DIR/rollback-backend.env"
   ```

   Do the same for every service you start: `worker`, `superset`, `superset-init`, `bootstrap`
   and `novu`, each into `rollback-<service>.env`. A `.env` file holds one value per line, so
   check that no value spans lines (base64 values such as `ZITADEL_KEY_JSON` are fine).

2. Check, then start **with the production override still in place** plus the rollback override
   (`docker-compose.rollback.yml`, #970). It switches the loader off, so each service runs its
   normal start command and reads its `rollback-<service>.env`. Backend and worker also keep their
   role file, because they still need OpenBao for Transit.

   ```bash
   pnpm --filter @platform/openbao-deploy check:prod-compose --rollback
   docker compose -f docker-compose.yml -f docker-compose.prod.yml \
     -f docker-compose.rollback.yml up -d
   ```

   Never roll back by dropping `-f docker-compose.prod.yml`: that starts the dev OpenBao, and the
   base file's inline values would win over any `env_file`.

3. When the cutover is signed off (or the rollback has ended), delete the files with `shred -u`.

## Reboot and unseal order

OpenBao starts **sealed** after a reboot, and OpenWind can't start until it is unsealed.

1. **[ops repo]** Unseal OpenBao (manual Shamir unseal by the key holders).
2. Check it is ready:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://openbao.example.com/v1/sys/health
   ```

   `200` means unsealed and active. `503` means still sealed.

3. Start or re-check OpenWind: `$DC up -d`, then `$DC ps`.
   - Long-running services were retrying meanwhile: the loader waits `BAO_WAIT_SECONDS` (default
     120), exits 69, and Docker's restart policy starts it again.
   - One-shots (`superset-init`, `bootstrap`) have `restart: "no"`: they stop on the first failure
     and Docker never restarts them. `superset` waits for `superset-init` to succeed. Re-run them
     by hand once OpenBao is unsealed:

     ```bash
     $DC up -d superset-init        # then superset starts after it completes
     $DC --profile bootstrap run --rm bootstrap   # only if a bootstrap run is due
     ```

Services that don't use OpenBao (`postgres`, `pgbouncer`, `redis`) start on their own.

## Rotating a role's secret ID

Secret IDs expire (finite `secret_id_ttl`, for example 30 days — **[ops repo]**). Rotate each role
before it expires; an alert at half its lifetime gives time (**[ops repo]**: rotation job and
alert).

```bash
umask 077
ROLE=<role-name-for-backend>
FILE="$OPENWIND_SECRETS_DIR/backend.env"
bao list auth/approle/role/$ROLE/secret-id                    # note the current accessor(s)
{
  grep '^OPENBAO_ROLE_ID=' "$FILE"
  echo "OPENBAO_SECRET_ID=$(bao write -f -field=secret_id auth/approle/role/$ROLE/secret-id)"
} > "$FILE.new" && mv "$FILE.new" "$FILE"
$DC up -d --force-recreate ow-backend
$DC logs --since 2m ow-backend | grep '\[bao-env\]'           # expect "applied <n> keys"
bao write auth/approle/role/$ROLE/secret-id-accessor/destroy secret_id_accessor=<old-accessor>
```

`--force-recreate` is needed because the role file is read when the container is created. Destroy
the old secret ID only after the service is back up. `novu.env` serves both Novu containers, so
recreate both.

## Changing a secret

Values are read once, at container start. A change needs a restart of every service that reads it.

```bash
printf '%s' "$NEW_VALUE" | bao kv patch -mount=secret openwind/prod/backend SOME_KEY=-
$DC restart ow-backend
```

- If the key is stored at more than one path, change it at each path.
- KV v2 keeps old versions. To undo:
  `bao kv rollback -mount=secret -version=<n> openwind/prod/backend`, then restart.
- Some keys need more than a restart: `REPORTING_BINDING_SECRET` needs a migrations re-run (see
  [Cutover](#2-rotate-cheap-published-secrets--before-cutover)); `SECRET_KEY` and
  `STORE_ENCRYPTION_KEY` need their rotation plans.

## Rotating the Transit key

Connector credentials are encrypted with the Transit key. Rotating it adds a new version; old
versions still decrypt until you raise the minimum.

1. **[ops repo]** Rotate: `bao write -f transit/keys/<key>/rotate`. New encryptions use the new
   version at once; existing ciphertext still decrypts.
2. **[ops repo]** Rewrap: move every stored ciphertext to the new version (`transit/rewrap`, with
   each row's tenant as the derivation context). There is no rewrap job in this repository yet.
3. Only after the rewrap has finished, and **no retained database backup still needs an older
   version**, raise the minimum:
   `bao write transit/keys/<key>/config min_decryption_version=<n>`.

Raising the minimum too early makes older ciphertext — including in backups — undecryptable.

## Certificate renewal

OpenWind talks to OpenBao over `https` only, and checks the certificate name.

- **[ops repo]** After renewing OpenBao's certificate, OpenBao reloads it (`SIGHUP`) without a
  restart.
- OpenWind needs no change if the name and issuing CA are the same. If the CA changes, update the
  CA trust in the images and restart the secret-holding services.
- Check: restart one service (`$DC restart superset`) and confirm it logs `applied <n> keys`.

## Checking that address binding works

A role's login must work only from OpenWind's own network. Check it from a machine **outside** the
allowed addresses (a laptop, or a container not on `OPENBAO_NETWORK`), with a real role ID and
secret ID in a `0600` file:

```bash
umask 077
W=$(mktemp -d)                                  # mode 0700
vi -n -i NONE "$W/login.json"                   # {"role_id": "...", "secret_id": "..."}
curl -s -w '\n%{http_code}\n' https://openbao.example.com/v1/auth/approle/login -d @"$W/login.json"
shred -u "$W/login.json"; rm -rf "$W"
```

Expect an error and **no** `client_token`. If you get a token, the binding is missing — rotate that
secret ID and tell the OpenBao owner (**[ops repo]**).

The loader has its own guard: when `OPENBAO_NETWORK_CIDR` is set it won't send credentials unless
`OPENBAO_ADDR` resolves inside that range. Always set it in production.

## Backup and restore with OpenBao

`connector_credentials` holds only Transit ciphertext. **A database backup is useless for
connector credentials without the matching Transit key.** Treat the database dump and the OpenBao
snapshot as one backup set. See [backup-dr-runbook](../specs/backup-dr-runbook.md) R5.

- **Back up together:** the database (`scripts/backup.sh`, see
  [local setup](../local-setup.md#backup--disaster-recovery)) and OpenBao (**[ops repo]**: snapshot
  and key custody). Record which snapshot goes with which dump.
- **Restore order:**
  1. OpenBao restored and **unsealed** (**[ops repo]**).
  2. Database restored.
  3. Applications started (`$DC up -d`).
- **Test before go-live:** restore both into a non-production target, start the apps, and decrypt
  one existing credential (for example, run a connector that uses it). Time it.
- **Not in either backup:** the role files and the non-secret `.env`. If the server is lost:
  - role files: re-onboard, i.e. issue new secret IDs and rewrite the files
    ([first-time setup](#first-time-setup) step 3);
  - `.env`: rebuild it from `.env.production.example`.

## Troubleshooting by loader exit code

Find the exit code with `$DC ps -a`, and the reason in the service's log lines that start with
`[bao-env]`. The loader never prints values, only key names and counts.

| Exit  | Meaning                                                | Usual causes and fixes                                                                                                                                                                                                                                                                                             |
| ----- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 69    | OpenBao unreachable or sealed after `BAO_WAIT_SECONDS` | OpenBao sealed (unseal, see [Reboot](#reboot-and-unseal-order)); OpenBao down; container not on `OPENBAO_NETWORK`.                                                                                                                                                                                                 |
| 77    | Refused: login or read rejected (HTTP 400/403/404)     | Secret ID expired, destroyed or wrong (rotate it); login from an address outside the binding; the role's policy doesn't cover the KV path, or the path is wrong (`BAO_KV_PATH`, `OPENWIND_BAO_ENV`). The loader waits `BAO_FAIL_SLEEP_SECONDS` (default 30) before exiting, so a restart loop stays slow.          |
| 78    | Configuration or keys                                  | `OPENBAO_ADDR` not `https://`; a required setting unset; `OPENBAO_ADDR` doesn't resolve inside `OPENBAO_NETWORK_CIDR`; a `BAO_REQUIRED_KEYS` key missing or empty in KV; a key set both by compose and in KV (remove it from compose — OpenBao is the source). Also waits `BAO_FAIL_SLEEP_SECONDS` before exiting. |
| other | The app itself exited                                  | The loader started the app; read the app's own log.                                                                                                                                                                                                                                                                |

The Prometheus rules include `OpenBaoDown` and `OpenBaoSealed`; they fire only once an OpenBao
scrape job is enabled in `docker/observability/prometheus.yml` (it ships commented out, because the
target is deployment-specific).

**To enable the alerts:** in your deployment's copy of `docker/observability/prometheus.yml`,
uncomment the `openbao` scrape job and set its target to OpenBao's address and port. Then make sure
Prometheus can reach it: put Prometheus on the OpenBao project network, or scrape through an address
that's allowed. Also make sure the metrics endpoint answers it, either through unauthenticated
metrics access or a metrics token. That is an **[ops repo]** setting on the OpenBao listener.
Reload Prometheus, then check that `up{job="openbao"}` is `1` before relying on the alerts.
