import { and, eq, gt, inArray, ne } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import {
  onCallRotations,
  onCallScheduleNotices,
  onCallSchedules,
} from "@platform/db";
import { writeAuditEntry } from "@platform/audit";
import {
  ROTATION_MAX_CYCLE_DAYS,
  ROTATION_MIN_CYCLE_DAYS,
} from "@platform/teams";

type RotationRow = typeof onCallRotations.$inferSelect;
type ScheduleRow = typeof onCallSchedules.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Removes the rotation's windows that have not started (and the notices already sent for
 * them) and points the cursor back at where the first removed one began, so a later resume
 * continues from there instead of leaving a gap. `exceptId` keeps one window (the one being
 * edited) out of the removal.
 */
export async function releaseUpcomingWindows(
  tx: DbOrTx,
  tenantId: string,
  actorId: string,
  rotation: RotationRow,
  options: { exceptId?: string; afterStartsAt?: Date; reason?: string } = {},
): Promise<number> {
  const upcoming = await tx
    .select({
      id: onCallSchedules.id,
      label: onCallSchedules.label,
      startsAt: onCallSchedules.startsAt,
      endsAt: onCallSchedules.endsAt,
    })
    .from(onCallSchedules)
    .where(
      and(
        eq(onCallSchedules.tenantId, tenantId),
        eq(onCallSchedules.rotationId, rotation.id),
        gt(onCallSchedules.startsAt, new Date()),
        ...(options.exceptId ? [ne(onCallSchedules.id, options.exceptId)] : []),
        ...(options.afterStartsAt
          ? [gt(onCallSchedules.startsAt, options.afterStartsAt)]
          : []),
      ),
    );
  if (upcoming.length === 0) return 0;
  const ids = upcoming.map((w) => w.id);
  await tx
    .delete(onCallScheduleNotices)
    .where(
      and(
        eq(onCallScheduleNotices.tenantId, tenantId),
        inArray(onCallScheduleNotices.scheduleId, ids),
      ),
    );
  await tx
    .delete(onCallSchedules)
    .where(
      and(
        eq(onCallSchedules.tenantId, tenantId),
        inArray(onCallSchedules.id, ids),
      ),
    );
  for (const w of upcoming) {
    await writeAuditEntry(tx, {
      tenantId,
      actorId,
      actorType: "user",
      resourceType: "on_call_schedule",
      resourceId: w.id,
      action: "deleted",
      beforeSnapshot: {
        rotationId: rotation.id,
        label: w.label,
        startsAt: w.startsAt,
        endsAt: w.endsAt,
        reason: options.reason ?? "rotation paused",
      },
    });
  }
  const earliest = upcoming.reduce((a, b) => (a.startsAt < b.startsAt ? a : b));
  await tx
    .update(onCallRotations)
    .set({ nextStartsAt: earliest.startsAt, updatedAt: new Date() })
    .where(
      and(
        eq(onCallRotations.id, rotation.id),
        eq(onCallRotations.tenantId, tenantId),
      ),
    );
  return upcoming.length;
}

async function loadRotation(
  tx: DbOrTx,
  tenantId: string,
  rotationId: string,
): Promise<RotationRow | undefined> {
  const [rotation] = await tx
    .select()
    .from(onCallRotations)
    .where(
      and(
        eq(onCallRotations.id, rotationId),
        eq(onCallRotations.tenantId, tenantId),
      ),
    )
    .limit(1);
  return rotation;
}

/**
 * First half of re-planning a repeating roster after one of its windows is resized: remove the
 * windows that come after it and have not started, before the window itself is updated, so a
 * longer window does not run into the next one. Earlier windows are never touched.
 */
export async function releaseWindowsAfter(
  tx: DbOrTx,
  tenantId: string,
  actorId: string,
  window: ScheduleRow,
): Promise<void> {
  if (!window.rotationId) return;
  const rotation = await loadRotation(tx, tenantId, window.rotationId);
  if (!rotation) return;
  await releaseUpcomingWindows(tx, tenantId, actorId, rotation, {
    exceptId: window.id,
    afterStartsAt: window.startsAt,
    reason: "roster window length changed",
  });
}

/**
 * Second half, after the window was updated: the next window starts where this one now ends, and
 * a whole-day length (3 to 90) becomes the rotation's cycle. The caller holds the rotation's row
 * lock, the same one the worker takes before generating.
 */
export async function alignRotationCursor(
  tx: DbOrTx,
  tenantId: string,
  actorId: string,
  window: ScheduleRow,
): Promise<void> {
  if (!window.rotationId) return;
  const rotation = await loadRotation(tx, tenantId, window.rotationId);
  if (!rotation) return;

  const days = (window.endsAt.getTime() - window.startsAt.getTime()) / DAY_MS;
  const wholeCycle =
    Number.isInteger(days) &&
    days >= ROTATION_MIN_CYCLE_DAYS &&
    days <= ROTATION_MAX_CYCLE_DAYS
      ? days
      : rotation.cycleDays;

  await tx
    .update(onCallRotations)
    .set({
      nextStartsAt: window.endsAt,
      cycleDays: wholeCycle,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(onCallRotations.id, rotation.id),
        eq(onCallRotations.tenantId, tenantId),
      ),
    );
  await writeAuditEntry(tx, {
    tenantId,
    actorId,
    actorType: "user",
    resourceType: "on_call_rotation",
    resourceId: rotation.id,
    action: "updated",
    beforeSnapshot: {
      cycleDays: rotation.cycleDays,
      nextStartsAt: rotation.nextStartsAt,
    },
    afterSnapshot: { cycleDays: wholeCycle, nextStartsAt: window.endsAt },
  });
}
