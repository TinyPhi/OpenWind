/**
 * Recurring on-call rotation rules (docs/specs/oncall-team-rotation.md R5, R6).
 * Pure functions: no database, no clock. The worker supplies the members, the
 * cursor and `now`; everything here is deterministic and unit-tested.
 */

export const ROTATION_MIN_CYCLE_DAYS = 3;
export const ROTATION_MAX_CYCLE_DAYS = 90;
export const ROTATION_DEFAULT_CYCLE_DAYS = 7;
export const ROTATION_MAX_STEPS_PER_RUN = 52;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A window is generated once the current one is within this long of ending. */
export const ROTATION_NOTICE_LEAD_MS = 2 * DAY_MS;

export type RotationHolders = {
  primary: string | null;
  backup: string | null;
};

export type NextAssignment = { primary: string; backup: string | null };

/**
 * Who takes over next. `members` is the team in rotation order.
 *
 * Primary: the member after the previous primary, wrapping; a previous primary
 * who is no longer a member (or none) hands over to the head of the list.
 * Backup: the member after the previous backup the same way; with no previous
 * backup it is the member after the new primary, and a departed previous backup
 * hands over to the head of the list. Whoever lands on the primary is skipped
 * (backup moves on); a one-member team has no backup. Returns null for a team
 * with no members.
 */
export function nextAssignment(
  members: readonly string[],
  previous: RotationHolders,
): NextAssignment | null {
  const n = members.length;
  if (n === 0) return null;

  const primaryAt = previous.primary ? members.indexOf(previous.primary) : -1;
  const primaryIdx = primaryAt === -1 ? 0 : (primaryAt + 1) % n;
  const primary = members[primaryIdx] as string;
  if (n === 1) return { primary, backup: null };

  const backupAt = previous.backup ? members.indexOf(previous.backup) : -1;
  let backupIdx: number;
  if (previous.backup === null) backupIdx = (primaryIdx + 1) % n;
  else backupIdx = backupAt === -1 ? 0 : (backupAt + 1) % n;
  if (members[backupIdx] === primary) backupIdx = (backupIdx + 1) % n;

  return { primary, backup: members[backupIdx] as string };
}

export type GeneratedWindow = {
  startsAt: Date;
  endsAt: Date;
  primary: string;
  backup: string | null;
  escalationManager: string | null;
};

export type PlanWindowsInput = {
  members: readonly string[];
  cycleDays: number;
  /** Start of the next window to create: the end of the last one made. */
  nextStartsAt: Date;
  /** The latest window that still exists, else the stored cursor. */
  previous: RotationHolders;
  escalationManager: string | null;
  now: Date;
  /** `YYYY-MM-DD` (UTC): no window may start after this day. */
  endsOn: string | null;
  maxSteps?: number;
};

export type PlanWindowsResult = {
  /** Windows to create, in order. Cycles already over are stepped past, never listed. */
  windows: GeneratedWindow[];
  skippedEnded: number;
  /** The step cap stopped generation while more cycles were still due. */
  capped: boolean;
  stoppedBy: "no_members" | "ends_on" | null;
  /** Where generation continues, and the last assignment (including stepped-past cycles). */
  cursor: {
    nextStartsAt: Date;
    lastPrimary: string | null;
    lastBackup: string | null;
  };
};

/**
 * Steps the rotation forward for as long as the next window is due, i.e. its
 * start is within the notice lead of `now`. Windows are back to back and exactly
 * `cycleDays` x 24 h long (UTC, no DST adjustment). After an outage this walks
 * every missed cycle in order, each with its own rotation step, up to the cap;
 * a cycle that is already over advances the assignment but yields no window, so
 * history is never back-filled. The escalation manager is carried over unchanged
 * and left empty if they are no longer a member.
 */
export function planWindows(input: PlanWindowsInput): PlanWindowsResult {
  const cycleMs = input.cycleDays * DAY_MS;
  const maxSteps = input.maxSteps ?? ROTATION_MAX_STEPS_PER_RUN;
  const nowMs = input.now.getTime();
  const dueUntilMs = nowMs + ROTATION_NOTICE_LEAD_MS;
  const startLimitMs = input.endsOn
    ? Date.parse(`${input.endsOn}T00:00:00Z`) + DAY_MS
    : Number.POSITIVE_INFINITY;
  const escalationManager =
    input.escalationManager && input.members.includes(input.escalationManager)
      ? input.escalationManager
      : null;

  let startMs = input.nextStartsAt.getTime();
  let previous = input.previous;
  const windows: GeneratedWindow[] = [];
  let skippedEnded = 0;
  let steps = 0;
  let capped = false;
  let stoppedBy: PlanWindowsResult["stoppedBy"] = null;

  if (input.members.length === 0) {
    stoppedBy = "no_members";
  } else {
    while (startMs <= dueUntilMs) {
      if (startMs >= startLimitMs) {
        stoppedBy = "ends_on";
        break;
      }
      if (steps >= maxSteps) {
        capped = true;
        break;
      }
      steps++;
      const next = nextAssignment(input.members, previous) as NextAssignment; // members is non-empty here
      const endMs = startMs + cycleMs;
      if (endMs > nowMs) {
        windows.push({
          startsAt: new Date(startMs),
          endsAt: new Date(endMs),
          primary: next.primary,
          backup: next.backup,
          escalationManager,
        });
      } else {
        skippedEnded++;
      }
      previous = next;
      startMs = endMs;
    }
  }

  return {
    windows,
    skippedEnded,
    capped,
    stoppedBy,
    cursor: {
      nextStartsAt: new Date(startMs),
      lastPrimary: previous.primary,
      lastBackup: previous.backup,
    },
  };
}

export type ProjectWindowsInput = {
  members: readonly string[];
  cycleDays: number;
  /** Start of the first window not made yet: the rotation's cursor. */
  nextStartsAt: Date;
  previous: RotationHolders;
  escalationManager: string | null;
  endsOn: string | null;
  count: number;
};

/**
 * The windows a rotation would make next, for display only. Same rules as
 * planWindows (wrap, collision skip, ends-on) but with no clock: nothing here
 * is created, and the real windows may differ if the team changes first.
 */
export function projectWindows(input: ProjectWindowsInput): GeneratedWindow[] {
  const cycleMs = input.cycleDays * DAY_MS;
  const startLimitMs = input.endsOn
    ? Date.parse(`${input.endsOn}T00:00:00Z`) + DAY_MS
    : Number.POSITIVE_INFINITY;
  const escalationManager =
    input.escalationManager && input.members.includes(input.escalationManager)
      ? input.escalationManager
      : null;
  const out: GeneratedWindow[] = [];
  let startMs = input.nextStartsAt.getTime();
  let previous = input.previous;
  while (out.length < input.count && startMs < startLimitMs) {
    const next = nextAssignment(input.members, previous);
    if (!next) break;
    out.push({
      startsAt: new Date(startMs),
      endsAt: new Date(startMs + cycleMs),
      primary: next.primary,
      backup: next.backup,
      escalationManager,
    });
    previous = next;
    startMs += cycleMs;
  }
  return out;
}

/** A window that has already started is never announced (R8). */
export function shouldAnnounceWindow(startsAt: Date, now: Date): boolean {
  return startsAt.getTime() > now.getTime();
}
