# Single-Command Setup

> One `setup.bat` / `setup.sh` turns a fresh clone into a running OpenWind — no manual steps, no extra folders in the repo.

status: approved
created: 2026-06-22
updated: 2026-06-22

---

## §G Goal

`git clone` + `setup.bat` = fully running OpenWind with Zitadel, backend, frontend, and demo users.
Zero host dependencies beyond Docker Desktop. No extra commands, no copy-pasting tokens.

---

## §C Constraints

| constraint       | value                                                                |
| ---------------- | -------------------------------------------------------------------- |
| stack            | Docker Desktop (Windows/Mac/Linux) — only runtime requirement        |
| zitadel source   | official image `ghcr.io/zitadel/zitadel:v4.15.1` pulled at runtime   |
| zitadel location | sibling folder `../zitadel/` — created by setup script, not in repo  |
| secret storage   | PAT used only in-memory during setup; key JSON written to .env.local |
| out of scope     | multi-machine / remote Zitadel; production TLS; custom domains       |
| out of scope     | `zitadel/` folder shipped in the OpenWind git repo                   |

---

## §I Interfaces

**Directory layout after setup runs:**

```
<parent>/
  openwind/          ← git clone (no zitadel/ inside)
    setup.bat
    setup.sh
    .env.local       ← written by bootstrap (gitignored)
  zitadel/           ← created at runtime by setup script
    docker-compose.yml
    scripts/
      gen-pat.mjs
```

**`.env.local` keys written by bootstrap:**

- `ZITADEL_ISSUER`, `ZITADEL_AUDIENCE`, `ZITADEL_CLIENT_ID`, `ZITADEL_CLIENT_SECRET`
- `ZITADEL_SERVICE_ACCOUNT_KEY` (key JSON — replaces PAT for runtime API calls)
- `DATABASE_URL`, `REDIS_URL`, and all other platform vars

---

## §R Requirements

R1: Single entry point
✓ User runs exactly one command (`setup.bat` or `./setup.sh`) from the repo root
✓ No manual steps between clone and running app

R2: Zitadel provisioned at runtime — not shipped in repo
✓ `git clone` produces no `zitadel/` directory
✓ `setup.bat` creates `../zitadel/` with compose file + gen-pat.mjs written inline
✓ Subsequent runs skip creation if `../zitadel/` already exists (idempotent)

R3: PAT generated automatically — never shown to user
✓ gen-pat.mjs runs headlessly inside a container; PAT captured by setup script
✓ PAT is passed directly to bootstrap via env var; never written to disk as a PAT
✓ Bootstrap converts PAT → key JSON and stores `ZITADEL_SERVICE_ACCOUNT_KEY` in .env.local

R4: Key JSON replaces PAT for all runtime API calls
✓ After bootstrap, API server authenticates to Zitadel using key JSON, not PAT
✓ `ZITADEL_SETUP_PAT` is not present in `.env.local` after setup completes

R5: .env.local is pre-created as a file before any docker volume mount
✓ Setup script runs `touch .env.local` (Linux/Mac) or `type nul > .env.local` (Windows) before `docker compose up`
✓ Docker never creates `.env.local` as a directory

R6: Idempotent re-runs
✓ Running `setup.bat` a second time on an existing install does not break the running system
✓ If Zitadel containers are already up, script detects this and skips Zitadel startup
✓ If `.env.local` already has credentials, bootstrap updates only missing keys

R7: Failure is visible and actionable
✓ Each phase prints a clear label before running
✓ On failure, script prints the failing phase name and the exact `docker compose logs` command to diagnose
✓ Exit code is non-zero on any failure

---

## §V Invariants

- PAT never touches disk — in-memory pipe from gen-pat.mjs container stdout to bootstrap env var only
- `zitadel/` is always a sibling of the repo root, never inside it
- `.env.local` is always a regular file before bootstrap runs (never a directory)
- Key JSON generation must succeed for setup to be marked complete; PAT fallback is not acceptable in production
- Machine user `openwind-api-bot` is the sole holder of Zitadel admin credentials post-setup

---

## §T Tasks

| id  | task                                                                                    | phase | status | depends |
| --- | --------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | git rm -r zitadel/ from repo; update .gitignore                                         | 1     | todo   | —       |
| T2  | Rewrite setup.bat: create ../zitadel/ inline, start Zitadel, capture PAT, run bootstrap | 1     | todo   | T1      |
| T3  | Rewrite setup.sh: same flow for Linux/Mac                                               | 1     | todo   | T1      |
| T4  | Fix bootstrap.ts: assert key JSON written; remove PAT from .env.local after bootstrap   | 1     | todo   | —       |
| T5  | Update SETUP.md: single-command instructions only                                       | 1     | todo   | T2,T3   |
| T6  | Test: fresh clone → setup.bat → app reachable at localhost:3001                         | 2     | todo   | T2,T3   |
| T7  | Test: re-run setup.bat on existing install — no breakage                                | 2     | todo   | T6      |

phase gate: app reachable at localhost:3001 with owAdmin login before marking done

## §B Bugs / Backprop Log

| id  | what failed                                             | root cause                                                              | promoted to §V? |
| --- | ------------------------------------------------------- | ----------------------------------------------------------------------- | --------------- |
| B1  | readFileSync EISDIR on .env.local                       | Docker creates dir when source path missing on volume mount             | ✓ (R5, §V)      |
| B2  | PAT creation 400 "not allowed for this user type"       | PATs are machine-user-only; human admin cannot hold a PAT               | ✓ (§V)          |
| B3  | gen-pat.mjs stuck at MFA prompt / change-password       | Zitadel shows extra login steps on first human login                    | ✓ (§V)          |
| B4  | docker compose up failed "no such service: ow-database" | setup script used container_name aliases not service names              | ✓ (§V)          |
| B5  | bootstrap key JSON skipped silently                     | looked for "setup-admin" user; machine user renamed to openwind-api-bot | ✓ (§V)          |

---

_spec is source of truth — update as decisions are made_
