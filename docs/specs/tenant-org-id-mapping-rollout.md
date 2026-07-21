# Rollout Runbook: Tenant ↔ Zitadel Org ID Mapping

**Spec:** docs/specs/tenant-org-id-mapping.md
**Applies to:** the production server (openwind.rokkalabs.com)

This is a manual, one-time rollout for the server. Do these steps in order;
each has a checkpoint before moving on. Nothing here should be scripted into
a migration — the specific org id below is this deployment's own Zitadel org,
not something a fresh self-hosted install would reuse.

---

## 0. Prerequisites (should already be true after this branch merges)

- [ ] Server has pulled the branch containing this fix and rebuilt `ow-backend`
- [ ] Migration `0034_tenants_zitadel_org_id.sql` has been applied
      (`docker compose exec ow-backend pnpm db:migrate`, same procedure as
      prior migrations on this server)

## 1. Insert the tenant row for the real org (read-only check first)

Confirm no tenant is already mapped to this org (should return 0 rows):

```bash
docker compose exec postgres psql -U platform -d platform \
  -c "SELECT id, name FROM tenants WHERE zitadel_org_id = '378675861571829762';"
```

If empty, insert the mapping. Reuses the existing "Demo Company" tenant row
by mapping it to the real org — the 1 pre-existing demo entity stays reachable,
consistent with what was agreed for this rollout:

```bash
docker compose exec postgres psql -U platform -d platform \
  -c "UPDATE tenants SET zitadel_org_id = '378675861571829762' WHERE id = '00000000-0000-0000-0000-000000000001';"
```

Verify:

```bash
docker compose exec postgres psql -U platform -d platform \
  -c "SELECT id, name, zitadel_org_id, status FROM tenants;"
```

Expect exactly one row, `zitadel_org_id` = `378675861571829762`, `status` = `active`.

## 2. Flip NODE_ENV and remove DEV_TENANT_ID

```bash
sed -i 's/^NODE_ENV=.*/NODE_ENV=production/' .env.local
sed -i '/^DEV_TENANT_ID=/d' .env.local
grep -n "NODE_ENV\|DEV_TENANT_ID\|CORS_ORIGIN" .env.local
```

If `CORS_ORIGIN` is not already present, add it (required in production —
see `packages/config/src/env.ts` refinement):

```bash
echo "CORS_ORIGIN=https://openwind.rokkalabs.com" >> .env.local
```

## 3. Restart and check boot succeeds

```bash
docker compose up -d ow-backend
docker compose logs ow-backend --tail=20
```

Expect the normal "API server listening" / "Modules registry seeded" lines —
**no** Zod validation error, no crash loop. A Zod error here means step 1 or 2
was skipped or mistyped; the app will exit before this refinement:
`DEV_TENANT_ID must not be set in production` or
`CORS_ORIGIN must be set in production`.

## 4. Smoke test (manual, in browser)

- [ ] Log out and log back in at `https://openwind.rokkalabs.com` (old tokens
      predate this change and must be refreshed)
- [ ] Users tab shows the real org's users, not a 404 or empty list
- [ ] Open a couple of records/workflows — no 500s
- [ ] `docker compose logs ow-backend --tail=100` — no `invalid input syntax
for type uuid` anywhere in the window since restart

## 5. If anything breaks

Revert step 2 (`NODE_ENV=development`, restore `DEV_TENANT_ID=00000000-0000-0000-0000-000000000001`),
restart `ow-backend`. The tenant mapping from step 1 is harmless to leave in
place either way.
