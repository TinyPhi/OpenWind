# ADR-014: Notification SLA / Retry / Escalation Policy

**Status:** Accepted.  
**Date:** 2026-08-24.  
**Deciders:** Engineering Lead.  
**Related to:** #125 (`notify` action → Novu delivery worker, shipped PR #211), ADR-012 Decision
#6 (async attachment-scan-failure handling — the closest existing precedent for "async operation
fails after its triggering request already returned success"), issue #19 (3D observability).  
**Supersedes:** —  
**Superseded by:** -

---

## Context

Novu-based notification delivery shipped in Phase 2A with working infrastructure
(`apps/worker/src/notification-worker.ts`, `notification-outbound-worker.ts`,
`notification-poller.ts`, `alert-worker.ts`) but no written policy for target latency, retry
limits, or what happens when delivery is exhausted. What exists today, found by reading the
code rather than assuming:

- **Retry is already BullMQ `attempts`/`backoff`, not ad hoc.** `apps/worker/src/queues.ts`
  configures most queues at `attempts: 3` with exponential backoff (1s base: 1s/2s/4s); the
  SLA-timer queue is the one exception at `attempts: 5`. Notification delivery queues currently
  follow the 3-attempt default.
- **Exhaustion already has a defined path**, not a silent drop: `notification-outbound-worker.ts`
  checks `job.attemptsMade >= (job.opts.attempts ?? 1)` and, on exhaustion, records a failure
  reason and (per its surrounding code/tests) flows into the same `system.error` path other
  worker failures use.
- **No target latency is written down anywhere** — "how fast should a notification arrive" has no
  answer today, in-app, email, or otherwise.
- **No escalation exists for SLA-tied notifications specifically** — e.g. a ticket-breach warning
  that fails to deliver has the same fate as any other failed notification (system.error), nothing
  ties its failure back to the workflow SLA it was supposed to warn about.
- **ADR-012 already solved an analogous problem** (Decision #6): when an async attachment AV scan
  fails _after_ its triggering request already returned success, the resolution was — quarantine
  the artifact, add an automatic system note to the entity explaining why, log it, raise an admin
  alert, and explicitly do _not_ try to build a new outbound notification channel just for this
  one case. That's a close structural match for "a notification about entity X failed after the
  triggering event already happened" and is reused below rather than re-derived.
- **An "admin alert" delivery channel already exists — it doesn't need to be built.** The
  `notifications` table already carries a free-text, dot-notation `type` column (existing values:
  `"ticket.alert"` in `alert-worker.ts`, `"comment.created"` in `notification-worker.ts`), and
  `apps/worker/src/notification-recipients.ts` already resolves an admin recipient set (an
  `admins` array, plus an `env.SYSTEM_ADMIN_USER_ID` fallback when no tenant admin is found). What
  doesn't exist is a `type` value or trigger for "a notification itself failed to deliver" — that's
  a small addition to an already-working pipeline, not a new one.

---

## Decision (proposed)

1. **Retry semantics: keep the existing BullMQ `attempts: 3` / exponential 1s-base backoff as the
   platform default for notification delivery queues** — it's already what's configured, already
   tested, and there's no evidence of it being wrong (no incident data suggests 3 attempts is
   insufficient). Don't invent a notification-specific number without a reason.
2. **No numeric target-latency SLA is set per channel.** Email/push delivery time is bounded by
   the upstream provider (Novu → the actual channel), not something OpenWind's worker queue depth
   controls in isolation — publishing a number like "delivered within 60s" would be a claim about
   infrastructure this platform doesn't fully own. Instead: **in-app notifications** (fully
   in-house, via the existing poller) get a latency target, since that path is fully controlled —
   proposed: p95 under 5s from trigger to poll-visible. Email/push get a **process** commitment
   (3 attempts, exponential backoff, ~7s total worst-case retry window) rather than a wall-clock
   delivery guarantee.
3. **On exhaustion, reuse ADR-012 Decision #6's shape, wired through the admin-alert channel that
   already exists (Context, last bullet) — no new delivery mechanism.** The failure is (a) logged
   with full context, (b) surfaces as an automatic system note on whatever entity the notification
   was about (mirroring how a quarantined attachment gets a system note on its ticket), and (c)
   inserts a `notifications` row with a new `type` value (e.g. `"notification.delivery_failed"`,
   consistent with the existing `ticket.alert`/`comment.created` dot-notation convention) targeted
   at the same admin-recipient resolution `notification-recipients.ts` already implements. This
   resolves what was originally this draft's OQ-3: the question isn't "does an admin-alert channel
   need to be built," it's "reuse the one that's already there." **Do not build a
   notification-about-a-failed-notification channel that bypasses this existing pipeline** — same
   reasoning ADR-012 already gave: a second channel would be disproportionate and duplicative.
4. **SLA-tied notifications (e.g., a ticket-breach warning) get one addition beyond (3):** the
   system note explicitly names the SLA/workflow-transition context it was warning about, so a
   silently-failed breach warning doesn't read as "nothing happened" to whoever later investigates
   why an SLA was missed without an escalation. This is the one place this draft diverges from
   treating all notification failures identically — an SLA breach warning failing silently has a
   materially worse consequence (a missed deadline nobody was told about) than, say, a "comment
   added" notification failing.
5. **Escalation stops at "visible system note + admin alert" — no automatic re-routing to a
   different channel or a different recipient.** A future need for that (e.g., "if email fails,
   try SMS") is real but unbuilt; adding it now would be speculative given no channel beyond
   email/push/in-app exists yet.

---

## Consequences

### Positive

- Reuses two already-reviewed/already-built patterns (ADR-012 Decision #6's failure shape, and the
  existing `notifications`/admin-recipient pipeline) instead of inventing new ones, keeping
  "what happens when an async side-effect fails after the triggering request succeeded" — and
  "how does an admin get told about it" — consistent across the codebase.
- Doesn't commit the platform to a wall-clock delivery SLA it can't actually guarantee for
  provider-dependent channels (email/push).

### Negative and mitigations

- **In-app's 5s p95 target is a proposed number with no load-test data behind it yet.**
  Mitigation: it's the one channel fully in OpenWind's control, so it's measurable and revisable
  once real poller-latency data exists — treat it as a starting target, not a hard commitment.
- **No cross-channel failover** means a notification that matters (an SLA breach warning) can
  still fail to reach a human if they don't independently check the entity's system notes or the
  new admin alert. Mitigation: this is an explicit, named scope cut (Decision #5), not an
  oversight — revisit if a pilot customer reports a missed-notification incident that this gap
  caused.
- **The new `"notification.delivery_failed"` type value needs a template** (per
  `notification-templates.ts`'s existing per-type template registry) — a small, additive
  implementation task, not a design gap, but real work not yet done.

---

## Deferred Decisions

| Deferred Item                                                                                                                  | Trigger to Revisit                                                            | Why Deferred Now                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Emitting a metric/event for SLA-tied notification failures beyond the system note + admin alert (originally this draft's OQ-2) | issue #19 (3D observability) shipping actual code                             | #19 doesn't exist as working code yet (confirmed — no metrics/tracing infrastructure found in `apps/worker`); the admin alert (Decision #3) already covers the "a human finds out" requirement without waiting on #19. |
| Cross-channel failover (email → SMS, etc.) on exhaustion                                                                       | A pilot customer reports a missed-notification incident traceable to this gap | No channel beyond email/push/in-app exists yet; building failover for channels that don't exist is speculative.                                                                                                        |

---

## Open Questions

| ID   | Question                                                                   | Notes                                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 | Is 5s p95 the right in-app latency target, or should it be tighter/looser? | No load-test data yet — proposed as a starting point, not derived from measurement. The only genuinely open item; resolving it needs real poller-latency data, not a design decision. |

---

## Implementation next steps

1. This draft should be reviewed and formally accepted (moved into
   `docs/decisions/ADR-014-notification-sla-retry-escalation.md` with `Status: Accepted`) by a
   human, per this repo's own rule that ADR files are human-authored/committed.
2. Add the `"notification.delivery_failed"` type to `notification-templates.ts`'s template
   registry and wire `notification-outbound-worker.ts`'s existing exhaustion path (the
   `job.attemptsMade >= (job.opts.attempts ?? 1)` check) to insert it via the existing
   `notification-recipients.ts` admin-resolution path, per Decision #3.
3. Add the SLA-context-naming addition (Decision #4) specifically to the SLA-timer notification
   path, not the general notification-worker path.
4. Instrument in-app poller latency (Decision #2's 5s p95 target) so OQ-1 can be answered with
   real data rather than left as a permanent assumption.
