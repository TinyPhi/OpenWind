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
