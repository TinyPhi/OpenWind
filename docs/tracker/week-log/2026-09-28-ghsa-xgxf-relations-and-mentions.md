# 2026-09-28 — Relation route and mention grants validated (GHSA-xgxf-m4r9-xm4v)

**Session type:** Security fix (developed in the advisory's private fork)
**Advisory:** GHSA-xgxf-m4r9-xm4v (medium, same-tenant only)
**Branch:** `fix/ghsa-xgxf-relations-mentions`

## Fixes

- **`POST /entities/:id/relations`** (`create-relation.ts`):
  - It refuses the engine-owned types `parent_of`, `child_of`, `references` and `referenced_by`,
    whatever their case or padding, with a 422 pointing to the children and references routes.
    Written through the generic route, they skipped the one-parent, depth and cycle rules while
    `get.ts`, `my-tickets.ts` and `add-comment.ts` still read them as real hierarchy.
  - A `user`-role caller must now be able to read the **target** as well as the source. A target
    they can't read gets exactly the same 404 body as a missing one
    (`RELATION_TARGET_NOT_FOUND` / "Not found"), including the `getEntity` not-found path, so the
    route can't be used to probe which ticket ids exist.
  - Admin and agent behaviour is unchanged, except that the reserved types are refused for them too.
- **UI @mention grants** (`add-comment.ts`):
  - Only tenant members (`tenant_users`) receive an access entry, the same rule `grant-access.ts`
    enforces.
  - A mention now only _adds_ access for a member with none. It never rewrites an existing
    `__accessUsers` entry, which previously let a mention silently raise or lower a user's level.
  - New grants keep the requested level. That matches `grant-access.ts`, which lets the same
    principals choose any level.

## Verification

- New `create-relation-guards.isolation.test.ts` (4 cases, real Postgres): reserved types are
  refused; no-access, missing and cross-tenant targets return identical 404 bodies; readable
  targets still link; agents keep tenant-wide linking but never cross tenants. Two cases fail
  against the pre-fix route.
- `add-comment.test.ts` gains two cases: a non-member mention gets no grant, and an existing entry
  is never rewritten. Both fail against the pre-fix handler.
- The admin UI only reads these relation types (GET), so nothing it does is affected.

## Review round 1 (PrabhuVijit, 2026-09-29)

- `create-relation.ts`: the string-message sentinel is now a typed `TargetUnavailableError`,
  checked with `instanceof`, following the `EntityError`/`WorkflowError` pattern. The 404 body is
  unchanged. A comment above `ENGINE_RELATION_TYPES` says the constants are lowercase.
- `add-comment.ts`: the tenant-membership lookup now runs whenever there are mentions, not only
  when the commenter can grant access. A non-member mention now gets neither an access grant nor a
  `comment.mentioned` notification row. Before, it produced an in-app row under this tenant that
  the non-member could never see. The grant-loop lookup is now a `Set`.
- Tests:
  - new unit case: a non-member mention by a commenter who can't grant access is not notified.
    It fails against the round-0 code.
  - the agent cross-tenant case in `create-relation-guards.isolation.test.ts` now asserts the 404
    body, which matches the user-role body.
- Verified: add-comment 18/18; api isolation 113 files / 769 tests on a fresh migrated database;
  typecheck and lint pass.
