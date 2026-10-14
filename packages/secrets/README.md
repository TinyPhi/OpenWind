# @platform/secrets

Encrypts and decrypts connector credentials (`connector_credentials.secrets`) per tenant.
Design: ADR-009 (connector runtime) and ADR-023 (OpenBao as the platform secrets manager).

## API

```ts
import { encryptCredential, decryptCredential } from "@platform/secrets";

const ciphertext = await encryptCredential(tenantId, plaintext);
const plaintext = await decryptCredential(tenantId, ciphertext);
```

- The tenant ID is the encryption context: ciphertext written for one tenant does not
  decrypt as another. This binds ciphertext to a tenant; it is **not** access control. A
  caller that can decrypt can decrypt any tenant's ciphertext by passing that tenant's ID, so
  tenant isolation still rests on tenant-scoped reads and RLS (ADR-023 Decision 8).
- Never log plaintext, and never put it in an error message.

## Providers

`SECRETS_PROVIDER` (from `@platform/config`) chooses where **new** values are encrypted:

| Provider            | Encrypts with                                    | Use                      |
| ------------------- | ------------------------------------------------ | ------------------------ |
| `openbao` (default) | OpenBao Transit, key `OPENBAO_TRANSIT_KEY`       | Every environment        |
| `local`             | AES-256-GCM with a key **published in the repo** | Tests and local dev only |

Decrypt chooses by the ciphertext itself: values starting with `local:` use the local
provider, everything else goes to OpenBao. In production, `local` is refused at startup and
`local:` ciphertext is refused at decrypt. Before relying on that in a database that existed
earlier, run `pnpm --filter @platform/db db:check-local-ciphertext` (read-only; must report
zero).

## Configuration

| Variable                               | Meaning                                                |
| -------------------------------------- | ------------------------------------------------------ |
| `OPENBAO_ADDR`                         | Server URL. Must be `https://` in production           |
| `OPENBAO_TRANSIT_KEY`                  | Transit key name                                       |
| `OPENBAO_ROLE_ID`, `OPENBAO_SECRET_ID` | AppRole login. Required in production                  |
| `OPENBAO_TOKEN`                        | Static token for local dev only; refused in production |

Empty values count as unset.

## Client behavior

- Every request has a 10-second timeout.
- Network errors, 429 and 5xx (including 503 while OpenBao is sealed) are retried up to 3
  attempts with short backoff. 4xx responses are not retried.
- The AppRole token is cached, renewed at about 2/3 of its lease, and replaced by a new login
  when renewal is refused or nearly exhausted. Concurrent callers share one login.
- On a 403 the client logs in again once and retries the request; a second 403 fails.
- A static `OPENBAO_TOKEN` is used as is, with no login.
