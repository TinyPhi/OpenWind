# Per-user erasure: anonymize, don't delete (#688)

> Extend per-user erasure to user ids and names that live inside JSON payloads and text, and
> shift the policy from deleting business records to anonymizing them, keeping as much business
> data as the law allows.

status: implemented
created: 2026-09-27
updated: 2026-09-27

---

## §G Goal

After `DELETE /users/:userId`, no row in the tenant identifies the erased user, and every
business record they touched survives with its identity removed. That covers tickets, vendors,
workflow history, comments, access-grant history, on-call coverage history and integrations.

Builds on #681 (`apps/api/src/services/user-erasure.ts`); this branch is stacked on it.

## §C Constraints

| constraint                  | value                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| policy (decided 2026-09-27) | Anonymize identity, keep the record. Delete only rows that are personal or ephemeral with no business value. **Not legal advice**: counsel should confirm the retention list in §I before it's relied on for compliance  |
| placeholder                 | one flat `'[REDACTED]'` everywhere. No per-user pseudonym: linkability ("these 40 actions were one person") can re-identify, and pseudonymized data is still personal data (Recital 26)                                  |
| same transaction            | every step runs in the route's existing `withTenantContext` transaction, with explicit `tenant_id` filters                                                                                                               |
| display name                | read from `tenant_users.display_name` **before** that row is deleted. If none is recorded, the text rewrite is skipped (ids are still scrubbed)                                                                          |
| text rewrite scope          | `@<display name>` becomes `@[REDACTED]` only in comments whose `metadata.mentions` contains the target, so a same-named colleague elsewhere isn't touched                                                                |
| out of scope                | unmentioned free-text references ("spoke to Alice"), which are a manual process on request; notification titles/bodies sent to _others_ (left to the #636 retention sweep); `admin_audit_log` (unchanged, Art. 17(3)(b)) |

## §I Interfaces

**Delete → anonymize changes to #681's behaviour:**

| data                                                                                          | #681    | now                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api_keys` the user created                                                                   | deleted | **kept and active, `created_by` redacted, on a forced rotation window.** `expires_at` is pulled in to at most `API_KEY_ROTATION_GRACE_DAYS` (30) from now, and the route writes one `updated` audit entry per key (`resourceType: api_key`, `{reason: "creator_erased", rotateBy}`) so admins can find and rotate them. Keys are org-owned (scopes live on the key), the Stripe/GitHub-App pattern; decided 2026-09-27 |
| `access_requests` the user raised                                                             | deleted | **resolved ones kept, `requester_id` redacted** (access-grant history); pending ones deleted (dead requests)                                                                                                                                                                                                                                                                                                           |
| `on_call_schedules` where user is primary                                                     | deleted | **every shift kept, primary redacted.** The resolver skips an unresolvable primary and pages backup, then escalation, so current and future shifts keep their remaining cover                                                                                                                                                                                                                                          |
| `ticket_alerts`, `saved_views`, `notification_recipients`, `tenant_users`, `idempotency_keys` | deleted | unchanged: personal or ephemeral                                                                                                                                                                                                                                                                                                                                                                                       |

**New coverage:**

| where                                                                    | action                                                                     |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `entity_instances.fields.<f>` for every tenant field of type `user_ref`  | value = target → key removed, or `'[REDACTED]'` if the field `is_required` |
| `workflow_events.metadata.mentions`                                      | target removed from the array                                              |
| `workflow_events.metadata.actorName` on events whose actor is the target | `'[REDACTED]'`, set in the same statement that redacts `actor_id`          |
| `workflow_events.metadata.text` of comments mentioning the target        | `@<display name>` → `@[REDACTED]`                                          |

**Field-type guard:** `USER_ID_FIELD_TYPES: Record<EntityField["fieldType"], boolean>` in
`user-erasure.ts`, exhaustive at compile time. A new field type fails `tsc` until it is
classified; only `true` types are scrubbed from `fields`.

## §R Requirements

- R1: No `user_ref` field value (required or optional) equals the target after erasure.
- R2: No comment's `mentions` contains the target, no event authored by the target keeps its
  `actorName`, and mentioning comments no longer contain `@<display name>`. Other text is untouched.
- R3: API keys the target created survive with `created_by` redacted, stay usable, expire within 30 days at most, and are each audited for rotation.
- R4: Resolved access requests survive with `requester_id` redacted; pending ones are deleted.
- R5: Every on-call shift survives with the primary redacted, so backup and escalation cover stay.
- R6: Other users' data and other tenants are untouched (the existing bystander checks stay green).
- R7: A new field type fails typecheck until classified in `USER_ID_FIELD_TYPES`.

## §V Invariants

- V1: identity is scrubbed, the record is kept, unless the row is personal or ephemeral (§I).
- V2: text rewriting only touches comments that recorded a mention of the target.

## §T Tasks

| id  | task                                                                                                                                                                                                           | req    | status |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| T1  | Extend `user-erasure-coverage.isolation.test.ts`: user_ref (required + optional), mentions/actorName/text, api key survival, access-request split, on-call past/future, bystander text untouched — fails first | R1–R6  | todo   |
| T2  | `user-erasure.ts`: delete→anonymize changes (api_keys, access_requests, on-call)                                                                                                                               | R3–R5  | done   |
| T3  | `user-erasure.ts`: user_ref fields, metadata mentions/actorName/text; display name read before `tenant_users` delete                                                                                           | R1, R2 | todo   |
| T4  | `USER_ID_FIELD_TYPES` exhaustive map                                                                                                                                                                           | R7     | done   |
| T5  | Docs: spec, week-log, pending-findings (mark #688 addressed), note the #681 behaviour change                                                                                                                   | —      | done   |

## §B Bugs / Backprop Log

- **B1 — proved before the fix.** `user-erasure-anonymization.isolation.test.ts` failed 6 of 8
  before the service change. The two bystander checks passed both before and after, as they
  should.
- **B2 — #681 test updated, not weakened.** `user-erasure-coverage` asserted that the target's
  API keys were deleted and a rotated key's `rotated_from` was cleared. Keys are now kept, so it
  asserts the opposite: the original key survives with `created_by` redacted, and the rotated key
  keeps its lineage pointer. The `rotated_from` pre-clear is removed, since nothing is deleted
  any more.
- **B4 (review) — word-boundary rewrite.** Plain `replace()` turned "@Anne" into "@[REDACTED]e"
  when the target was "Ann". It now uses `regexp_replace` with the name escaped, bound as a
  parameter, and `(?![[:alnum:]_])`. Names under 3 characters don't touch text; the ids are
  still scrubbed from `mentions`.
- **B5 (review) — more identity in `workflow_events.metadata`.** `actingPersonId` (third-party
  writes, where the actor is the API key) and field-change history (`changed.<field>.old/new`)
  both kept the raw id. Both are now redacted.
- **B6 (review) — on-call shifts kept, not deleted.** Deleting current and future shifts removed
  backup and escalation cover, because the resolver would have paged them. Every shift is now
  kept with the primary redacted.
- **B7 (security review) — erased user's API keys.** Kept-but-untouched keys stayed fully live
  and became untraceable under the shared placeholder. Owner decision: a forced rotation window
  (`expires_at` ≤ now + 30 days, ADR-008 expiry) plus a per-key audit entry, instead of
  revoking.
- **B8 (review) — bystander tenant.** The anonymization test now seeds a second tenant with the
  same user id and name in fields, comments and history, and asserts it is untouched.
- **B9 (PR #690 review).**
  - Change-history aggregate wrapped in `COALESCE(…, '{}')`.
  - Explicit `status <> 'pending'` guard on the access-request anonymize.
  - A flat-`fields` contract comment on the `user_ref` scrub.
  - An idempotency test: a second erasure succeeds, returns no keys, and changes nothing.
  - `access_requests.status` is CHECK-constrained to `pending/approved/rejected`, so the
    pending-delete/anonymize split covers every row, with no intermediate statuses.
- **For counsel (PR #690 review):**
  - `admin_audit_log` keeps `actor_id` and `acting_person_id` on per-user erasure
    (Art. 17(3)(b)). The exemption being relied on covers the **identifiers in the audit
    rows**, not only row retention. Counsel's sign-off must cover that explicitly.
  - Users with display names under 3 characters have their id scrubbed from `mentions`, but
    `@Jo`-style text stays. This is an accepted trade-off against false positives.
- **Follow-up:** third-party comment mentions (identifiers or emails in text, resolved later) —
  #689.
- **B3 — `actorName` in the same statement as `actor_id`.** Once `actor_id` is redacted, the
  target's events can't be found again, so both are set together.
