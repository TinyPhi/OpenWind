## 2026-07-10 — Security audit findings #8 and #9 (closes the full 2026-07-09 audit)

### Done

**#8 — introspection cache key upgraded from a 32-bit hash to SHA-256:**

- `packages/auth/src/introspection.ts`: `simpleHash` (djb2, 32-bit) replaced
  with `hashToken` (`createHash("sha256")`). A 32-bit hash has a large enough
  collision space (~4 billion buckets) that two distinct tokens could in
  theory hash to the same cache key, returning the wrong token's
  active/inactive introspection result for up to the 60s cache TTL.
- `packages/auth/src/introspection.test.ts`: +1 test proving two distinct
  tokens are cached independently (two real network calls, not one).

**#9 — `platform/users.ts` PII exposure to `user`-role callers: reviewed,
confirmed intentional, no code change.**

- Asked directly: `GET /users` returns every tenant member's
  email/displayName/loginName even to plain `user`-role (customer) callers.
  The code already documents this as deliberate (comment: "'user' role
  included: customers need this to resolve assignee display names on their
  records"). Confirmed with the user this is still the intended tradeoff —
  closing this out as reviewed, not a bug.

### Why

Last two items from the 2026-07-09 security audit's to-do list. Both
low-stakes: #8 is a defense-in-depth hardening (no confirmed exploit, just a
theoretical weakness in the cache key), #9 was a design question, not a code
issue.

### Verification

- pnpm typecheck: PASS (41/41)
- pnpm lint: PASS (direct eslint run, clean)
- pnpm test: PASS — `@platform/auth` 36/36 (up from 35, +1 new). Root
  `@platform/api` failures unchanged at the established 12-test baseline.
- pnpm test:isolation: PASS (134/134, unaffected by this change).

### Audit closed out

This closes the entire 2026-07-09 security audit (#1-#10). Summary of what
shipped across the six fix sessions:

1. Record-level read access enforced on entity/attachment/file reads (`0c043a9`)
2. CSV/XLSX formula injection sanitized (`1e3114b`)
3. JWT audience validation made fail-closed (`e2745e3`)
4. Zitadel error-body logging removed from failure paths (`4b78110`)
5. Tenant-status cache cross-instance invalidation via Redis pub/sub (`9178e30`)
6. automation-rules routes repaired (was a live production outage, not just
   hardening) + entity-types mutation belt-and-suspenders (`6330aaa`)
7. (bundled with #6 above)
8. Introspection cache key hardened to SHA-256 (this session)
9. `users.ts` PII exposure reviewed and confirmed intentional (this session)
10. Follow-up sweep found and fixed 6 more routes broken by the same RLS
    pattern as #6: admin/audit, api-keys create/list/delete,
    view-configs GET/PATCH, set-child-status (`cf52595`)

**Biggest takeaway:** roughly half of what started as "hardening" findings
turned out to be actively broken production features (API key management,
audit log viewing, view-config customization, child-ticket status,
automation rules) — all silently failing since the #121 RLS enforcement fix,
all invisible to existing tests because they mock the DB layer entirely.
Worth raising with the team: a lint rule or codemod flagging
`db.select/insert/update/delete` on a known-RLS table outside
`withTenantContext` would catch this bug class automatically. Not
implemented — a process idea, not a coded fix.

### Next

No open items from this audit. Possible follow-ups if wanted:
- The lint-rule/codemod idea above, to prevent this bug class from recurring.
- A live, real-Zitadel-JWT-backed e2e smoke test suite, since several fixes
  in this audit could only be verified via the isolation-test technique
  (bypassing JWT verification) rather than a true end-to-end request —
  correct and sufficient, but a real JWT-based e2e pass would close that gap.

### Open questions

- None blocking.
