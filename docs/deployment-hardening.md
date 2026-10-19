# Deployment hardening

OpenWind's default Docker Compose stack is suitable for development and a
single-host deployment, but it does not configure the host, reverse proxy,
storage encryption, or backup destination. Those controls belong to the
deploying organisation because OpenWind cannot inspect or enforce the
infrastructure outside its containers.

This guide defines the minimum production baseline and makes that boundary
explicit. Use it together with the production and backup sections of
[the setup guide](local-setup.md).

## Responsibility boundary

| Control              | OpenWind provides                                                                       | Deployer must provide                                                                   |
| -------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Authentication       | Zitadel OIDC, JWT validation, RBAC and tenant context                                   | HTTPS-safe Zitadel bootstrap values, identity-provider administration and recovery      |
| Tenant isolation     | PostgreSQL RLS plus application-layer tenant checks                                     | Restricted database/network access and timely security updates                          |
| Application secrets  | OpenBao Transit encryption for connector credentials; hashed API keys and upload tokens | A production OpenBao deployment, protected unseal/auth material and key rotation        |
| Transport encryption | An HTTPS redirect when a trusted proxy sends `X-Forwarded-Proto: http`                  | TLS termination, certificate renewal, HTTP-to-HTTPS redirects and HSTS                  |
| Data at rest         | Tenant-scoped file paths and database access controls                                   | Encryption for database, file-storage and backup volumes, with external key custody     |
| Backups              | `scripts/backup.sh` for PostgreSQL and local file storage                               | Scheduling, encrypted/off-host storage, retention, access control and restore exercises |

OpenBao Transit protects the credential values passed through
`@platform/secrets`. It does **not** encrypt the PostgreSQL data directory,
uploaded files, logs, or backup archives. Likewise, PostgreSQL RLS separates
tenant access but is not disk encryption.

## TLS termination and HSTS

Terminate TLS at a reverse proxy or load balancer. Do not expose the backend,
PostgreSQL, PgBouncer, Redis, OpenBao, or ClamAV directly to the internet. The
Compose stack binds the API to loopback by default; preserve that boundary and
route `/api/v1/` and `/ws/` through the same public origin as the frontend.

Minimum proxy requirements:

- allow TLS 1.2 and TLS 1.3 only;
- redirect every plain HTTP request to HTTPS;
- automate certificate renewal and alert before expiry;
- overwrite, rather than append to, client-supplied forwarding headers;
- send `X-Forwarded-Proto: https` to OpenWind on encrypted requests; and
- add HSTS only after every covered hostname works over HTTPS.

For nginx, add the following to the HTTPS `server` block shown in
`docs/local-setup.md`:

```nginx
ssl_protocols TLSv1.2 TLSv1.3;

# Start without includeSubDomains while validating every hostname. Add it only
# when all current and future subdomains are guaranteed to support HTTPS.
add_header Strict-Transport-Security "max-age=31536000" always;
```

Use a separate port-80 server solely for the redirect:

```nginx
server {
    listen 80;
    server_name openwind.example.com;
    return 301 https://$host$request_uri;
}
```

Apply equivalent settings to the Zitadel hostname. Set
`ZITADEL_EXTERNALSECURE=true` before Zitadel's first boot, as described in the
setup guide; Zitadel persists its issuer scheme during initialisation.

Do not enable HSTS preload casually. `includeSubDomains` and `preload` can make
unrelated or future subdomains unreachable if they are not HTTPS-ready. Treat
either addition as a domain-wide operational decision.

### Why the application cannot enforce TLS alone

`apps/api/src/middleware/https-enforcement.ts` can redirect a request only when
the proxy explicitly reports `X-Forwarded-Proto: http`. If the header is absent,
the application cannot distinguish a correctly terminated HTTPS request from a
direct HTTP request without breaking local development. The reverse proxy is
therefore the security boundary for HTTPS-only ingress.

Verify from outside the deployment network:

```bash
curl -I http://openwind.example.com/
curl -I https://openwind.example.com/
curl -I https://openwind.example.com/api/v1/health
```

Confirm the first response redirects to HTTPS, HTTPS responses include
`Strict-Transport-Security`, certificates are valid, and infrastructure ports
are not externally reachable.

## Encryption at rest

Use host-, volume-, or cloud-disk encryption for every persistent path. Common
choices include LUKS/dm-crypt on Linux, encrypted cloud block volumes,
FileVault-backed storage on macOS, and BitLocker-backed storage on Windows.
The exact mechanism is infrastructure-specific; OpenWind does not manage its
keys.

At minimum, encryption must cover:

- the PostgreSQL volume containing tenant and audit data;
- `FILES_STORAGE_PATH_HOST` (default `../openwind-files`), which contains
  uploaded file bytes;
- the Zitadel database volume;
- any persistent production OpenBao storage;
- logs, temporary files and crash dumps that may contain operational data; and
- every local or remote backup destination.

Keep disk-encryption keys outside the encrypted host or volume, restrict key
administration to a small operations group, and document recovery. Encryption
that automatically unlocks with credentials stored on the same unprotected
disk does not protect against host or snapshot theft.

For cloud deployments, enable encryption on volumes, snapshots and object
storage and prefer a customer-managed key when contractual or regulatory
requirements demand independent rotation and revocation. Record which key
protects each resource and test recovery after rotation.

## Backup encryption and handling

`scripts/backup.sh` produces a PostgreSQL dump and a copy of local file
storage. The script does not encrypt or move them off-host. Follow the backup
procedure in `docs/local-setup.md`, then apply these controls:

1. Write backups directly to an encrypted filesystem or encrypt the archive
   before it leaves the host.
2. Store the encryption key in a separate KMS, HSM, or secrets system—not in
   the backup directory or the same automation script.
3. Copy backups to a different failure domain; a backup on the application
   host does not survive loss of that host.
4. Restrict read/list access, log access to the destination, and use a defined
   retention/deletion policy.
5. Verify integrity and perform scheduled restores into an isolated scratch
   environment. An encrypted backup without a tested key-recovery path is not
   a recoverable backup.

The repository's current policy has a 24-hour RPO and no committed production
RTO. Encryption does not change those targets, but encryption and off-host copy
time must be included when measuring an actual restore.

## Production OpenBao

The Compose configuration runs OpenBao in dev mode with an in-memory store and
a development root token. Never reuse that configuration in production.
Provide a durable, backed-up OpenBao deployment with TLS, a documented
seal/unseal or auto-unseal process, least-privilege AppRole credentials, audit
logging, key rotation, and recovery procedures. Do not place a root token in
application environment files.

OpenWind uses tenant context when calling the Transit engine so connector
credential ciphertext is tenant-bound. Protecting the Transit key and its
recovery material remains the deployer's responsibility.

**Breaking change for existing production servers (ADR-023).** With
`NODE_ENV=production`, the API and worker refuse to start on `SECRETS_PROVIDER=local`,
a static `OPENBAO_TOKEN`, a non-`https://` `OPENBAO_ADDR`, a missing or default
`METRICS_TOKEN`, or a Superset secret left at its development default. They also no
longer read `.env.local`. A server still on the dev OpenBao must move to the ADR-023
setup before it is redeployed (see `CHANGELOG.md`).

The production model is decided in
[ADR-023](decisions/ADR-023-openbao-secrets-manager.md); the day-to-day steps
are in the [OpenBao secrets runbook](runbooks/openbao-secrets.md). In short:

- OpenBao is a separate server, not a service in OpenWind's compose project.
  The production override (`docker-compose.prod.yml`) keeps the dev `openbao`
  container from starting.
- Each secret-holding service (backend, worker, Superset, the `superset-init`
  and `bootstrap` one-shots, Novu) has its own AppRole and reads exactly one KV
  path, `secret/openwind/<env>/<service>`, once at container start. The
  frontend has no role; it gets only public values.
- OpenBao values win. A key set both by compose and by OpenBao stops the
  service from starting. `.env.local` is not read in production.
- If OpenBao is down, sealed or refuses the login, the service does not start.
  After a host reboot OpenWind waits until OpenBao is unsealed.
- OpenWind reaches OpenBao over a private per-project network, never through
  the public proxy, and only over `https`. Role logins are bound to that
  network's addresses.
- Connector credentials stay encrypted with Transit. A database backup can only
  be restored together with the matching OpenBao data (see
  [the backup runbook](specs/backup-dr-runbook.md)).
- Changing a secret means restarting the service that reads it.

## Zitadel machine-key rotation

OpenWind talks to Zitadel with three machine-user private keys. Each one is exchanged for a
short-lived access token on demand; the key file itself is the long-lived secret.

| Key          | Env                                                                           | Used for                                                                  |
| ------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| management   | `ZITADEL_SERVICE_ACCOUNT_KEY` or `ZITADEL_KEY_JSON`                           | Reading users, roles and org metadata                                     |
| provisioning | `ZITADEL_PROVISIONING_SERVICE_ACCOUNT_KEY` or `ZITADEL_PROVISIONING_KEY_JSON` | Sandbox org and user creation/deletion (instance-level `IAM_ORG_MANAGER`) |
| notification | `NOTIFICATION_ZITADEL_KEY_JSON`                                               | Authenticating calls to the outbound email/SMS service                    |

Rotation is manual. Give every key an expiry date when you create it and rotate all three
together, so they share one expiry.

### Expiry digest

A worker job (`apps/worker/src/zitadel-key-expiry.ts`) runs daily at 06:00 and once at every
worker start. It reads each configured key's id and machine user, asks Zitadel for that key's
live expiry and classifies it. The lookup is UserService `ListKeys`, made with the management
machine user, which needs `user.read` in each machine user's organization; it was confirmed
against the hosted Zitadel this deployment uses. The classes are:

- ok: more than 30 days left;
- a warning at 30, 14, 7, 3 and 1 day(s);
- expired;
- long-lived: expires more than a year away;
- never expires: no expiry date, or a far-future placeholder (Zitadel reports `9999-12-31`);
- missing: Zitadel doesn't list the key id in use: the key was deleted, or the management
  machine user can't see that machine user (grant it `user.read` in that user's organization,
  nothing broader);
- unknown: the lookup failed or the key file can't be read the way its consumer reads it, with
  the reason (for example `forbidden` or `unreadable_key_config`).

It emails one digest covering every key to `OPS_ALERT_EMAIL` (comma-separated addresses), only
when a key's state changed since the last digest. Expired, missing and unknown keys repeat daily;
long-lived and never-expiring keys repeat weekly. A first run where every key is fine sends nothing. Without
`OPS_ALERT_EMAIL` the job only logs.

The notification service treats an email body as one line of plain text: it doesn't render HTML
or keep line breaks. So the digest is a paragraph of plain sentences, most urgent first, for
example: "The provisioning key (...887810) never expires. Please swap it for a key with an
expiry date. The management key (...793090) expires in 2,999 days, on 1 January 2035. That is
more than a year away, so please swap it for a key with a shorter expiry."

Nothing about a key's expiry is stored in configuration. The check always follows whichever key
is configured, so after a rotation the next run reports the new dates.

The notification key is the one email depends on. Every run also logs a summary and exposes these
metrics, so alert on them as well as on the email:

- `openwind_zitadel_key_days_remaining{key}`, computed at scrape time;
- `openwind_zitadel_key_status{key,status}`;
- `openwind_zitadel_key_check_age_seconds`. Alert when it passes about 36 hours, because the
  daily check has stopped. The stored result expires after 3 days, and the metrics disappear
  with it.

### Rotating the keys

1. In the Zitadel console, for each machine user, add a new key **with an expiration date** (for
   example 90 days ahead, the same date for all three) and download the JSON.
2. Put the new values in the environment (`.env.local`, or the secret store in production),
   encoded the way each variable is read:
   - **raw JSON:** `ZITADEL_SERVICE_ACCOUNT_KEY`, `ZITADEL_PROVISIONING_SERVICE_ACCOUNT_KEY` and
     `NOTIFICATION_ZITADEL_KEY_JSON` (despite its name);
   - **base64 of the JSON:** `ZITADEL_KEY_JSON` and `ZITADEL_PROVISIONING_KEY_JSON`.

   A wrongly encoded key shows as "unknown [unreadable_key_config]".

3. Restart `ow-backend` and `ow-worker`. The worker runs the check on start, and its
   `zitadel-key-expiry: check complete` log line should show every key with the new date. If
   the previous digest reported a problem, a confirming digest is emailed.
4. Delete the old keys in the Zitadel console. A key that is still configured but deleted shows as
   "missing", which catches a half-finished rotation.

To check on demand, restart `ow-worker`.

## Container images: non-root, compiled, health-checked

`apps/api/Dockerfile` and `apps/worker/Dockerfile` are multi-stage builds on `node:22-slim`
with two targets:

- `runtime` (the default, last stage) runs `node dist/index.js` as the unprivileged `node`
  user (uid/gid 1000). It holds production dependencies only (`pnpm deploy --legacy --prod`),
  its code is root-owned and read-only to the app, and it has a `HEALTHCHECK`.
  `docker-compose.prod.yml` selects it with `build.target: runtime`.
- `dev` is the old behaviour: the whole workspace run with `tsx` as root. The base
  `docker-compose.yml` selects it, so `docker compose up -d` is unchanged for development.

Health checks run inside the container with `node` (the slim image has no `curl`): the API
polls `GET /health` on port 3000, the worker polls `GET /healthz` on port 3002 (healthy only
while both of its Redis connections are ready; it does not check Postgres). Nothing is
published for the worker port.

### File storage ownership

`/data/files` is where the API writes uploads and the worker's virus scan reads them. Both
now run as uid 1000, so the host directory behind `FILES_STORAGE_PATH_HOST` must be owned by
it, or every upload fails with a permission error:

```bash
sudo mkdir -p "$FILES_STORAGE_PATH_HOST"
sudo chown -R 1000:1000 "$FILES_STORAGE_PATH_HOST"
sudo chmod 750 "$FILES_STORAGE_PATH_HOST"
```

Existing deployments must run the `chown` once before switching to the new images; files
written earlier by root are otherwise readable but not deletable by the app. A fresh Docker
named volume mounted at `/data/files` needs nothing: the image creates the directory owned
by uid 1000, and Docker copies that ownership into an empty named volume. Rollback to the old
image is safe (root can read and write uid 1000 files).

## Go-live checklist

- [ ] Public HTTP redirects to HTTPS for both OpenWind and Zitadel.
- [ ] TLS 1.2/1.3 certificates renew automatically and expiry is monitored.
- [ ] HSTS is returned on HTTPS responses; domain-wide options were reviewed.
- [ ] Forwarding headers are overwritten by the single trusted proxy.
- [ ] Database, cache, secrets, worker and scanning ports are not public.
- [ ] PostgreSQL, uploads, Zitadel and production OpenBao storage are encrypted.
- [ ] Backup output is encrypted, access-controlled and copied off-host.
- [ ] Encryption and backup keys are stored separately from protected data.
- [ ] A restore, including key recovery, has been tested and timed.
- [ ] Production OpenBao is durable and does not use dev mode or a root token.
- [ ] An OpenBao restore has been tested together with a database restore.
- [ ] Every Zitadel machine key has an expiry date, `OPS_ALERT_EMAIL` is set, and the
      key-expiry metrics are alerted on.
- [ ] API and worker run the `runtime` image target (`node`, uid 1000, not `tsx`, not root),
      both report `healthy` in `docker ps`, and `FILES_STORAGE_PATH_HOST` is owned by 1000:1000.
