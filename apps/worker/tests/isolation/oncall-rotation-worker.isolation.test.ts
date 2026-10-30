/**
 * docs/specs/oncall-team-rotation.md R5-R8, R10: the recurring-roster worker against a real
 * Postgres. Time is passed in, so each case is deterministic. Only the Redis push and the BullMQ
 * outbound queue are stood in for (they are I/O to services this suite does not run).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  db,
  tenants,
  teams,
  teamMembers,
  onCallRotations,
  onCallSchedules,
  onCallScheduleNotices,
  notifications,
  notificationRecipients,
  adminAuditLog,
} from "@platform/db";

const { mockAdd } = vi.hoisted(() => ({
  mockAdd: vi.fn((..._args: unknown[]) => Promise.resolve()),
}));

vi.mock("../../src/queues.js", () => ({
  notifyOutboundQueue: { add: mockAdd },
}));
vi.mock("@platform/redis", () => ({
  getRedis: () => ({ publish: () => Promise.resolve(1) }),
  NOTIFICATION_PUSH_CHANNEL: "notification:push",
}));

const { rotationTick } = await import("../../src/oncall-rotation-worker.js");

const TENANT = "aaaaaaaa-1030-4000-a000-0000000000b1";
const OTHER_TENANT = "bbbbbbbb-1030-4000-b000-0000000000b2";
const SUSPENDED = "cccccccc-1030-4000-c000-0000000000b3";
const ADMIN = "u-rot-admin";
const [A, B, C, D] = ["u-rot-a", "u-rot-b", "u-rot-c", "u-rot-d"];
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2031-03-10T12:00:00Z");
const at = (days: number): Date => new Date(NOW.getTime() + days * DAY);

let n = 0;

async function seed(opts: {
  tenantId?: string;
  members?: string[];
  /** first window: starts/ends relative to NOW in days; primary A, backup B, escalation C */
  first?: { from: number; to: number };
  nextDays?: number;
  status?: "active" | "stopped";
  endsOn?: string | null;
  cycleDays?: number;
}): Promise<{ teamId: string; rotationId: string; firstId: string | null }> {
  const tenantId = opts.tenantId ?? TENANT;
  const members = opts.members ?? [A, B, C, D];
  const [team] = await db
    .insert(teams)
    .values({ tenantId, name: `rot-team-${++n}`, createdBy: ADMIN })
    .returning({ id: teams.id });
  const teamId = team!.id;
  if (members.length > 0) {
    // a person is on one team at a time, and every seed reuses the same few people
    await db
      .delete(teamMembers)
      .where(
        and(
          eq(teamMembers.tenantId, tenantId),
          inArray(teamMembers.userId, members),
        ),
      );
    await db.insert(teamMembers).values(
      members.map((userId, position) => ({
        tenantId,
        teamId,
        userId,
        position,
      })),
    );
  }
  const first = opts.first ?? { from: -6, to: 1 };
  const [rot] = await db
    .insert(onCallRotations)
    .values({
      tenantId,
      teamId,
      cycleDays: opts.cycleDays ?? 7,
      status: opts.status ?? "active",
      endsOn: opts.endsOn ?? null,
      nextStartsAt: at(opts.nextDays ?? first.to),
      lastPrimaryUserId: A,
      lastBackupUserId: B,
      escalationManagerUserId: C,
      createdBy: ADMIN,
    })
    .returning({ id: onCallRotations.id });
  const rotationId = rot!.id;
  let firstId: string | null = null;
  if (opts.first !== null) {
    const [w] = await db
      .insert(onCallSchedules)
      .values({
        tenantId,
        teamId,
        rotationId,
        label: "first",
        startsAt: at(first.from),
        endsAt: at(first.to),
        primaryUserId: A,
        backupUserId: B,
        escalationManagerUserId: C,
        createdBy: ADMIN,
      })
      .returning({ id: onCallSchedules.id });
    firstId = w!.id;
  }
  return { teamId, rotationId, firstId };
}

async function windows(rotationId: string) {
  return db
    .select()
    .from(onCallSchedules)
    .where(eq(onCallSchedules.rotationId, rotationId))
    .orderBy(asc(onCallSchedules.startsAt));
}

async function rotation(id: string) {
  const [r] = await db
    .select()
    .from(onCallRotations)
    .where(eq(onCallRotations.id, id));
  return r!;
}

beforeAll(async () => {
  await db.insert(tenants).values([
    { id: TENANT, name: "Rot A", slug: `rot-a-${TENANT}` },
    { id: OTHER_TENANT, name: "Rot B", slug: `rot-b-${OTHER_TENANT}` },
    {
      id: SUSPENDED,
      name: "Rot S",
      slug: `rot-s-${SUSPENDED}`,
      status: "suspended",
    },
  ]);
});

beforeEach(() => {
  mockAdd.mockClear();
});

afterAll(async () => {
  const all = [TENANT, OTHER_TENANT, SUSPENDED];
  await db
    .delete(onCallScheduleNotices)
    .where(inArray(onCallScheduleNotices.tenantId, all));
  await db.delete(notifications).where(inArray(notifications.tenantId, all));
  await db
    .delete(onCallSchedules)
    .where(inArray(onCallSchedules.tenantId, all));
  await db
    .delete(onCallRotations)
    .where(inArray(onCallRotations.tenantId, all));
  await db.delete(teamMembers).where(inArray(teamMembers.tenantId, all));
  await db.delete(teams).where(inArray(teams.tenantId, all));
  await db.delete(tenants).where(inArray(tenants.id, all));
});

describe("generation (R5, R6)", () => {
  it("makes nothing while the current window has more than two days left", async () => {
    const { rotationId } = await seed({ first: { from: -2, to: 5 } });
    await rotationTick(NOW);
    expect(await windows(rotationId)).toHaveLength(1);
  });

  it("makes the next window once the current one is within two days of ending, rotating the people", async () => {
    const { rotationId } = await seed({});
    await rotationTick(NOW);
    const ws = await windows(rotationId);
    expect(ws).toHaveLength(2);
    expect(ws[1]).toMatchObject({
      primaryUserId: B,
      backupUserId: C,
      escalationManagerUserId: C,
    });
    expect(ws[1]!.startsAt).toEqual(at(1));
    expect(ws[1]!.endsAt).toEqual(at(8));
    expect((await rotation(rotationId)).nextStartsAt).toEqual(at(8));
  });

  it("writes an audit entry for the generated window with a system actor and the creator as owner", async () => {
    const { rotationId } = await seed({});
    await rotationTick(NOW);
    const generated = (await windows(rotationId))[1]!;
    const [entry] = await db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.resourceId, generated.id));
    expect(entry).toMatchObject({
      actorType: "system",
      resourceType: "on_call_schedule",
    });
    expect((entry!.afterSnapshot as { ownerUserId: string }).ownerUserId).toBe(
      ADMIN,
    );
  });

  it("creates each window exactly once however many ticks run at the same time", async () => {
    const { rotationId } = await seed({});
    await Promise.all([
      rotationTick(NOW),
      rotationTick(NOW),
      rotationTick(NOW),
    ]);
    await rotationTick(NOW);
    const ws = await windows(rotationId);
    expect(ws).toHaveLength(2);
    const notices = await db
      .select()
      .from(onCallScheduleNotices)
      .where(eq(onCallScheduleNotices.scheduleId, ws[1]!.id));
    expect(notices).toHaveLength(3);
  });

  it("steps through missed cycles after an outage without back-filling ended windows", async () => {
    const { rotationId } = await seed({
      first: { from: -26, to: -19 },
      nextDays: -19,
    });
    await rotationTick(NOW);
    const ws = (await windows(rotationId)).slice(1);
    for (const w of ws)
      expect(w.endsAt.getTime()).toBeGreaterThan(NOW.getTime());
    // cycles [-19,-12) [-12,-5) are over; [-5,2) is current and [2,9) is within the lead
    expect(ws.map((w) => w.startsAt)).toEqual([at(-5), at(2)]);
    // three rotation steps happened before [-5,2): A/B -> B/C -> C/D -> D/A, so primary is D then A
    expect(ws.map((w) => w.primaryUserId)).toEqual([D, A]);
  });

  it("does not regenerate a deleted window and carries on with the next cycle", async () => {
    const { rotationId } = await seed({});
    await rotationTick(NOW);
    const generated = (await windows(rotationId))[1]!;
    await db
      .update(onCallSchedules)
      .set({ deletedAt: new Date() })
      .where(eq(onCallSchedules.id, generated.id));
    await rotationTick(NOW);
    expect(
      await db
        .select()
        .from(onCallSchedules)
        .where(
          and(
            eq(onCallSchedules.rotationId, rotationId),
            isNull(onCallSchedules.deletedAt),
          ),
        ),
    ).toHaveLength(1);
    expect(await windows(rotationId)).toHaveLength(2);
    // the next cycle (due once now+6d is within the lead of the cursor at 8d) follows the gap
    await rotationTick(at(6));
    const live = (await windows(rotationId)).filter((w) => !w.deletedAt);
    expect(live.map((w) => w.startsAt)).toEqual([at(-6), at(8)]);
  });

  it("continues from an admin's edit to the latest window", async () => {
    const { rotationId } = await seed({});
    await rotationTick(NOW);
    const generated = (await windows(rotationId))[1]!;
    await db
      .update(onCallSchedules)
      .set({ primaryUserId: C, backupUserId: A })
      .where(eq(onCallSchedules.id, generated.id));
    await rotationTick(at(6));
    const third = (await windows(rotationId))[2]!;
    expect(third).toMatchObject({ primaryUserId: D, backupUserId: B });
  });

  it("skips a former member's turn and hands it to the head of the list", async () => {
    // last window's primary left the team: the next primary is the first member
    const { rotationId } = await seed({ members: [B, C, D] });
    await rotationTick(NOW);
    const generated = (await windows(rotationId))[1]!;
    expect(generated.primaryUserId).toBe(B);
    expect(generated.escalationManagerUserId).toBe(C);
  });

  it("generates nothing for a stopped rotation, a deleted team or a suspended tenant", async () => {
    const stopped = await seed({ status: "stopped" });
    const deletedTeam = await seed({});
    await db
      .update(teams)
      .set({ deletedAt: new Date() })
      .where(eq(teams.id, deletedTeam.teamId));
    const suspended = await seed({ tenantId: SUSPENDED });
    await rotationTick(NOW);
    for (const r of [stopped, deletedTeam, suspended]) {
      expect(await windows(r.rotationId)).toHaveLength(1);
    }
    expect((await rotation(deletedTeam.rotationId)).blockedReason).toMatch(
      /team was deleted/,
    );
    expect((await rotation(stopped.rotationId)).blockedReason).toBeNull();
  });

  it("generates nothing past the end date", async () => {
    const { rotationId } = await seed({ endsOn: "2031-03-10" });
    await rotationTick(NOW);
    expect(await windows(rotationId)).toHaveLength(1);
  });

  it("marks a rotation whose team lost all its members as blocked", async () => {
    const { rotationId } = await seed({ members: [] });
    await rotationTick(NOW);
    expect(await windows(rotationId)).toHaveLength(1);
    expect((await rotation(rotationId)).blockedReason).toMatch(/no members/);
  });
});

describe("overlap (R6)", () => {
  it("blocks on a manual window, never overwrites it, and resumes when it is cleared", async () => {
    const { rotationId, teamId } = await seed({});
    const [manual] = await db
      .insert(onCallSchedules)
      .values({
        tenantId: TENANT,
        teamId,
        label: "manual cover",
        startsAt: at(3),
        endsAt: at(5),
        primaryUserId: D,
        createdBy: ADMIN,
      })
      .returning({ id: onCallSchedules.id });
    await rotationTick(NOW);
    expect(await windows(rotationId)).toHaveLength(1);
    const blocked = await rotation(rotationId);
    expect(blocked.blockedReason).toMatch(/manual cover/);
    expect(blocked.nextStartsAt).toEqual(at(1));
    const [untouched] = await db
      .select()
      .from(onCallSchedules)
      .where(eq(onCallSchedules.id, manual!.id));
    expect(untouched).toMatchObject({ startsAt: at(3), endsAt: at(5) });

    await db
      .update(onCallSchedules)
      .set({ deletedAt: new Date() })
      .where(eq(onCallSchedules.id, manual!.id));
    await rotationTick(NOW);
    expect(await windows(rotationId)).toHaveLength(2);
    expect((await rotation(rotationId)).blockedReason).toBeNull();
  });
});

describe("advance notice (R8)", () => {
  async function noticesFor(rotationId: string) {
    return db
      .select({
        userId: onCallScheduleNotices.userId,
        role: onCallScheduleNotices.role,
        scheduleId: onCallScheduleNotices.scheduleId,
      })
      .from(onCallScheduleNotices)
      .innerJoin(
        onCallSchedules,
        eq(onCallScheduleNotices.scheduleId, onCallSchedules.id),
      )
      .where(eq(onCallSchedules.rotationId, rotationId));
  }

  it("tells the new primary, backup and escalation manager once, in-app and by email", async () => {
    const { rotationId, firstId } = await seed({});
    await rotationTick(NOW);
    await rotationTick(NOW);
    const notices = await noticesFor(rotationId);
    expect(notices).toHaveLength(3);
    expect(notices.some((x) => x.scheduleId === firstId)).toBe(false);
    expect(notices.map((x) => `${x.userId}:${x.role}`).sort()).toEqual([
      `${B}:primary`,
      `${C}:backup`,
      `${C}:escalation_manager`,
    ]);
    const recipients = await db
      .select()
      .from(notificationRecipients)
      .where(eq(notificationRecipients.tenantId, TENANT));
    expect(recipients.filter((r) => r.userId === B)).not.toHaveLength(0);
    const [note] = await db
      .select()
      .from(notifications)
      .innerJoin(
        notificationRecipients,
        eq(notificationRecipients.notificationId, notifications.id),
      )
      .where(
        and(
          eq(notifications.type, "oncall.rotation_notice"),
          eq(notificationRecipients.userId, B),
        ),
      );
    expect(note!.notifications.body).toMatch(
      /You will be primary on call for rot-team-\d+ from 2031-03-11 12:00 UTC to 2031-03-18 12:00 UTC/,
    );
    expect(mockAdd).toHaveBeenCalled();
  });

  it("never announces a window that has already started", async () => {
    const { rotationId } = await seed({
      first: { from: -6, to: 1 },
      nextDays: 1,
    });
    // the generated window starts at +1d; run the tick after it began
    await rotationTick(NOW);
    await db
      .delete(onCallScheduleNotices)
      .where(eq(onCallScheduleNotices.tenantId, TENANT));
    await rotationTick(at(2));
    const gen = (await windows(rotationId))[1]!;
    const sent = await db
      .select()
      .from(onCallScheduleNotices)
      .where(eq(onCallScheduleNotices.scheduleId, gen.id));
    expect(sent).toHaveLength(0);
  });

  it("tells a person added to a window that has not started, once, and not the one removed", async () => {
    const { rotationId } = await seed({});
    await rotationTick(NOW);
    const gen = (await windows(rotationId))[1]!;
    await db
      .update(onCallSchedules)
      .set({ primaryUserId: D })
      .where(eq(onCallSchedules.id, gen.id));
    await rotationTick(NOW);
    await rotationTick(NOW);
    const notices = await db
      .select()
      .from(onCallScheduleNotices)
      .where(eq(onCallScheduleNotices.scheduleId, gen.id));
    expect(notices.filter((x) => x.userId === D)).toHaveLength(1);
    expect(notices.filter((x) => x.userId === B)).toHaveLength(1); // old primary already told, not told again
  });

  it("sends nothing for a suspended tenant", async () => {
    const { rotationId } = await seed({ tenantId: SUSPENDED });
    await rotationTick(NOW);
    expect(await noticesFor(rotationId)).toEqual([]);
  });
});

describe("the sweeper role's reach (ADR-016 addendum A3, R10)", () => {
  async function asSweeper<T>(
    fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE oncall_rotation_sweeper`);
      return fn(tx);
    });
  }

  it("reads the six discovery columns across every tenant", async () => {
    await seed({ tenantId: OTHER_TENANT });
    const rows = await asSweeper(async (tx) => {
      const r = await tx.execute<{ tenant_id: string }>(
        sql`SELECT id, tenant_id, team_id, status, next_starts_at, ends_on FROM on_call_rotations`,
      );
      return [...r];
    });
    const tenantsSeen = new Set(rows.map((r) => r.tenant_id));
    expect(tenantsSeen.has(TENANT)).toBe(true);
    expect(tenantsSeen.has(OTHER_TENANT)).toBe(true);
  });

  it("cannot read the people columns, other tables, or write anything", async () => {
    await expect(
      asSweeper((tx) =>
        tx.execute(sql`SELECT last_primary_user_id FROM on_call_rotations`),
      ),
    ).rejects.toThrow();
    await expect(
      asSweeper((tx) => tx.execute(sql`SELECT * FROM on_call_rotations`)),
    ).rejects.toThrow();
    await expect(
      asSweeper((tx) => tx.execute(sql`SELECT id FROM on_call_schedules`)),
    ).rejects.toThrow();
    await expect(
      asSweeper((tx) => tx.execute(sql`SELECT id FROM team_members`)),
    ).rejects.toThrow();
    await expect(
      asSweeper((tx) =>
        tx.execute(sql`UPDATE on_call_rotations SET status = 'stopped'`),
      ),
    ).rejects.toThrow();
  });
});
