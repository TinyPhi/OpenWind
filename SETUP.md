# OpenWind Setup

**Single requirement: Docker Desktop (must be running)**

No Node.js, no pnpm, no extra tooling. Everything runs in containers.

---

## First-time setup

```
git clone https://github.com/TusharSharma991/OpenWind.git
cd OpenWind

setup.bat          ← Windows
./setup.sh         ← Linux / Mac
```

That's it. One command. It takes 3–5 minutes on first run.

---

## What the script does

| Phase                        | What happens                                                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 — Zitadel provisioning** | Creates `../zitadel/` next to the repo, writes a `docker-compose.yml` using the official `ghcr.io/zitadel/zitadel:v4.15.1` image, starts the identity provider              |
| **2 — PAT generation**       | Runs a one-time Node.js container that logs into Zitadel headlessly, creates a machine user (`openwind-api-bot`), and generates a Personal Access Token — all automatically |
| **3 — Bootstrap**            | Runs DB migrations, seeds dev data, configures Zitadel OIDC (project, app, roles), creates demo users, and converts the PAT to a secure key JSON stored in `.env.local`     |
| **4 — App start**            | Starts `ow-backend` and `ow-frontend` with the generated credentials                                                                                                        |

The PAT is **never written to disk** — it lives in memory only, passed directly into the bootstrap container.

---

## After setup

Open **http://localhost:3001**

| Account    | Username                | Password        | Role          |
| ---------- | ----------------------- | --------------- | ------------- |
| Admin      | `owAdmin`               | `OpenWind1234!` | Full access   |
| User       | `owUser`                | `OpenWind1234!` | Portal access |
| Test users | `testUser1`–`testUser5` | `OpenWind1234!` | Portal access |

Zitadel console (identity provider): **http://localhost:8080**
Username: `owZitadelAdmin@openwind.local` / Password: see `ZITADEL_ADMIN_PASSWORD` in `.env.local`

---

## Re-running / resetting

```bash
# Restart everything (keeps data)
docker compose restart

# Full reset — wipes all data and re-bootstraps
docker compose down -v
cd ../zitadel && docker compose down -v && cd -
setup.bat   # or ./setup.sh
```

---

## Directory layout after setup

```
<parent>/
  OpenWind/        ← this repo
    .env.local     ← written by bootstrap (gitignored)
    setup.bat
    setup.sh
  zitadel/         ← created at runtime by setup script (not in git)
    docker-compose.yml
    output/        ← temp folder, cleaned after setup
```

---

## Security notes

- **MFA is disabled by default** (`FORCEMFA: false`) so the local dev experience works without an authenticator app. Before exposing this instance to the internet, enable MFA in the Zitadel console under **Default Settings → Login Policy → Force MFA**, or set `ZITADEL_DEFAULTINSTANCE_LOGINPOLICY_FORCEMFA: "true"` before first boot.
- **Generated secrets** (`ZITADEL_MASTERKEY`, `ZITADEL_ADMIN_PASSWORD`) are written to `.env.local` which is gitignored. Never commit this file.

---

## Troubleshooting

| Problem                  | Fix                                                                    |
| ------------------------ | ---------------------------------------------------------------------- |
| Zitadel won't start      | `docker compose logs zitadel` inside the `../zitadel/` folder          |
| Bootstrap failed         | Check the output — it prints the failing step                          |
| App not loading          | `docker compose logs ow-backend` in the repo folder                    |
| Port 8080 already in use | Stop the conflicting container or change `ZITADEL_HOST_PORT` in `.env` |
