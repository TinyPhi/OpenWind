# Spec: Global Outbound-Notifications Kill Switch

**Status:** approved-pending-plan-lock
**Author:** Claude Code (session), reviewed by Tushar
**Date:** 2026-07-25

---

## §C Context

The in-app notification hub (merged via the `notification` branch) is fully functional.
It also enqueues an **outbound handoff** — a BullMQ job on the `notify-outbound` queue —
intended for an external email/SMS/WhatsApp delivery service. That external service is
not live yet / is currently misbehaving. There is no way to disable the outbound handoff
without an env var change + container restart.

The operator wants a **single global toggle**, flippable live from the admin-ui settings
page, that stops new outbound dispatch jobs from being enqueued while leaving in-app
notification delivery (DB row + websocket push) completely unaffected. This is explicitly
**not per-tenant** — the failure mode is "the external service itself is down," which
affects all tenants identically, so per-tenant scoping would add complexity with no
matching real-world need.

---

## §R Requirements

- **R1**: A new single-row global settings store (`platform_settings` table) holds
  `outbound_notifications_enabled: boolean`, default `true` (current behavior unchanged
  until an admin explicitly flips it off).
- **R2**: `PATCH /admin/platform-settings` (admin-role-gated) flips the flag. Returns the
  updated value. Validated with Zod.
- **R3**: `GET /admin/platform-settings` (admin-role-gated) reads the current value, for
  the settings page to render initial state.
- **R4**: Both outbound-enqueue call sites —
  `packages/automation-engine/src/actions/notify.ts` (`queue.add("dispatch", ...)` on
  `notify-outbound`) and `apps/worker/src/notification-worker.ts:142`
  (`notifyOutboundQueue.add("dispatch", ...)`) — check the flag before enqueueing. When
  disabled, skip the enqueue (log at debug/info, do not throw, do not affect the in-app
  insert/websocket push that happens earlier in the same function).
- **R5**: **Fail-closed**: if the settings lookup itself errors (DB unreachable, row
  missing), treat outbound as **disabled** — do not enqueue. Rationale: the switch exists
  specifically to stop outbound traffic during an incident; erring toward "don't send" is
  safer than silently sending during an unrelated DB hiccup.
- **R6**: Admin-ui settings page gets a new toggle (admin-role-only, same
  optimistic-update-with-revert-on-failure UX pattern as the existing module-visibility
  toggle in `apps/admin-ui/src/pages/settings.tsx`).
- **R7**: No per-tenant scoping anywhere in this feature — one process-wide flag.
- **R8**: New table gets RLS-equivalent treatment consistent with other non-tenant-scoped
  platform tables (single row, no `tenant_id` column — this is intentionally global, not
  a tenant-scoped table, so standard tenant RLS policy does not apply; access control is
  via the admin-role-gated route only).

## §NR Non-Requirements (explicitly out of scope)

- No effect on in-app notification delivery — that must keep working when outbound is off.
- No retry/backfill of skipped outbound jobs when the flag is re-enabled — this is a
  simple skip, not a queue/pause mechanism. (BullMQ's own `queue.pause()` is intentionally
  not used here since we want new jobs to just never be created, not queued-and-stuck.)
- No audit-log requirement beyond what already exists for admin API mutations generically.

---

## §I Interfaces

```typescript
// packages/db/src/schema/platform.ts (new table)
export const platformSettings = pgTable("platform_settings", {
  id: integer("id").primaryKey().default(1), // single row, enforced by check constraint
  outboundNotificationsEnabled: boolean("outbound_notifications_enabled")
    .notNull()
    .default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: uuid("updated_by"), // actor user id, nullable
});
```

```typescript
// apps/api/src/routes/admin/platform-settings.ts
GET /admin/platform-settings   -> { data: { outboundNotificationsEnabled: boolean } }
PATCH /admin/platform-settings -> body: { outboundNotificationsEnabled: boolean }
                                -> { data: { outboundNotificationsEnabled: boolean } }
```

```typescript
// shared helper, e.g. packages/db/src/platform-settings.ts
export async function isOutboundNotificationsEnabled(): Promise<boolean> {
  try {
    const row = await db
      .select()
      .from(platformSettings)
      .where(eq(platformSettings.id, 1));
    return row[0]?.outboundNotificationsEnabled ?? false; // fail-closed on missing row
  } catch {
    return false; // fail-closed on error (R5)
  }
}
```

---

## §T Tasks (expanded below in the phase plan)

See `docs/specs/outbound-notifications-kill-switch-tasks.md`.
