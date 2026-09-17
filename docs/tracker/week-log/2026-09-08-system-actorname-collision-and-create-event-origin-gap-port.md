# 2026-09-08 — third-party API: system-actorname collision + missing create-event origin tagging (ported from the AuthNexus-paired fork)

Follow-up to the earlier same-day port (`6dd57912`, System Agent reply + username-mention
resolution). The sibling AuthNexus fork found two further bugs the same day, during further local
rebuild + live retest; this ports both.

## Bug 1: origin mislabel + would-be actorName collision on the System Agent reply

`postSystemComment` set `originMechanism: "api"` / `originOidcClientId` (copied from the request
context that triggered it) on the internally-generated System Agent comment. This made
`OriginTag` render it as `External · <caller's app>` — wrongly attributing an internal system
message to whichever third-party application's request happened to surface the failure.

Fixed by no longer setting any origin fields on this comment at all — a null origin renders no
tag (same convention `docs/specs/third-party-api-origin-tagging.md` §V already documents for
normal in-app creation). `postSystemComment` no longer takes an `originOidcClientId` parameter;
updated both call sites (`tickets.ts`, `children.ts`) to drop it.

While porting this, also changed the actor label from `"System Agent"` to **`"System"`**
(`post-system-comment.ts` and `mention-resolution-worker.ts`'s outcome-3 branch) — this branch's
own `list-workflow-events.ts` has the identical snapshot-name dedup guard the sibling fork's bug
report describes (discards `metadata.actorName` whenever it exactly equals `actorId`). This
branch never actually hit that collision (its actorName was `"System Agent"`, never equal to the
`actorId: "system"` sentinel), but capitalizing it now pre-empts ever landing on the same bug if
someone later simplifies the label to lowercase `"system"` without knowing why that's unsafe —
matches the sibling fork's final naming choice directly rather than the intermediate lowercase
step it went through first.

**Note:** this branch's `mention-resolution-worker.ts`'s `resolveIdentifier` does **not** have the
sibling fork's `u.email.toLowerCase()` crash (checked before porting) — `zitadel-management.ts`
here already defaults `email: u.human?.email?.email ?? ""` at the source, so `u.email` is never
`undefined` on this branch. Nothing to port for that specific issue.

## Bug 2: API-created tickets' own "create" history entry carried no attribution

`createEntity` (`packages/entity-engine/src/engine.ts`) hardcoded `triggeredBy: "user"` and never
forwarded `originMechanism`/`originOidcClientId`/`originPerformerUserId` onto the `workflow_events`
"create" row it inserts, despite writing those same fields onto `entity_instances` a few lines
above in the same call. A third-party API-created ticket's own creation history entry therefore
showed as if a human had created it, with no app/person attribution — unlike every other
API-originated event on the same ticket.

Fixed `triggeredBy` to map from `input.actorType` (with the same `"api_key"` → `"api"` mapping
`child-relations.ts` already used, since `workflow_events.triggered_by`'s vocabulary
(`user|automation|api|system`) is distinct from `actorType`'s), and forwarded the three origin
fields.

`createChildRelation` (`packages/entity-engine/src/child-relations.ts`) had the identical origin-
field gap on its own create-event insert (its `triggeredBy` mapping was already correct) — fixed
the same way.

## Verification

- `pnpm --filter @platform/entity-engine typecheck/lint`, `pnpm --filter @platform/api
typecheck/lint`, `pnpm --filter @platform/worker typecheck/lint`: all clean
- `mention-resolution-worker.test.ts`: 16 tests, green (assertion updated `"System Agent"` →
  `"System"`)
- `third-party-ticket-create.isolation.test.ts` / `third-party-subticket-create.isolation.test.ts`:
  assertions updated `"System Agent"` → `"System"` — **not run against this worktree's own DB**
  (hit a pre-existing local Postgres auth failure, `password authentication failed for user
"platform"`, unrelated to this change). Please re-run the isolation suite in your own
  environment to confirm against your DB/Redis setup before merging.

## Not ported

The sibling fork's collapsible-`OriginTag` UI and its `record-detail.tsx`
create/update/transition-event rendering fix are **not** ported here — this branch's
`origin-tag.tsx` is a structurally different, multi-component design (`OriginCornerBadge` /
`OriginTag` / `OriginHeaderPill` / `OriginDetailLine`) predating that UI work, and adapting it
needs its own dedicated pass rather than a direct port. Flagging this as a known follow-up, not
done silently.
