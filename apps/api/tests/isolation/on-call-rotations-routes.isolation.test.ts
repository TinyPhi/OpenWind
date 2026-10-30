/**
 * docs/specs/oncall-team-rotation.md R4, R9, R10: the rotation routes and the `repeat` create path,
 * against a real Postgres through the real routers. Zitadel is the only stand-in: each org lists
 * only its own users.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { asc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import {
  db,
  tenants,
  tenantUsers,
  teams,
  teamMembers,
  onCallRotations,
  onCallSchedules,
  withTenantContext,
} from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { onCallSchedulesRouter } from "../../src/routes/admin/on-call-schedules.js";
import { onCallRotationsRouter } from "../../src/routes/admin/on-call-rotations.js";

const TENANT_A = "aaaaaaaa-1030-4000-a000-0000000000c1";
const TENANT_B = "bbbbbbbb-1030-4000-b000-0000000000c2";
const ORG_A = "org-rot-a";
const ORG_B = "org-rot-b";
const ADMIN_A = "u-rotapi-admin-a";
const ASHA = "u-rotapi-asha";
const BEN = "u-rotapi-ben";
const ADMIN_B = "u-rotapi-admin-b";

vi.mock("../../src/lib/zitadel-management.js", () => ({
  listUserRolesByUserId: (orgId: string) =>
    Promise.resolve(
      orgId === "org-rot-a"
        ? new Map<string, string[]>([
            ["u-rotapi-admin-a", ["admin"]],
            ["u-rotapi-asha", ["agent"]],
            ["u-rotapi-ben", ["user"]],
          ])
        : new Map<string, string[]>([["u-rotapi-admin-b", ["admin"]]]),
    ),
  listOrgUsers: () => Promise.resolve([]),
}));

function makeApp(tenantId: string, orgId: string, userId: string) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId,
        userId,
        roles: ["admin"],
        email: "test@example.com",
        orgId,
      });
      await next();
    },
  );
  app.route("/admin/on-call-schedules", onCallSchedulesRouter);
  app.route("/admin/on-call-rotations", onCallRotationsRouter);
  return app;
}

const appA = makeApp(TENANT_A, ORG_A, ADMIN_A);
const appB = makeApp(TENANT_B, ORG_B, ADMIN_B);

function send(
  method: string,
  body?: unknown,
): { method: string; headers: Record<string, string>; body?: string } {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

let n = 0;

async function newTeam(members: string[]): Promise<string> {
  const [team] = await db
    .insert(teams)
    .values({
      tenantId: TENANT_A,
      name: `rotapi-team-${++n}`,
      createdBy: ADMIN_A,
    })
    .returning({ id: teams.id });
  if (members.length > 0) {
    await db.insert(teamMembers).values(
      members.map((userId, position) => ({
        tenantId: TENANT_A,
        teamId: team!.id,
        userId,
        position,
      })),
    );
  }
  return team!.id;
}

function windowBody(teamId: string, extra: object = {}) {
  return {
    teamId,
    label: "Week 1",
    startsAt: "2032-01-05T00:00:00Z",
    endsAt: "2032-01-12T00:00:00Z",
    primaryUserId: ASHA,
    backupUserId: BEN,
    ...extra,
  };
}

async function createRotation(
  teamId: string,
  extra: object = {},
): Promise<{ rotationId: string; scheduleId: string }> {
  const res = await appA.request(
    "/admin/on-call-schedules",
    send("POST", windowBody(teamId, { repeat: { cycleDays: 7 }, ...extra })),
  );
  expect(res.status).toBe(201);
  const { data } = (await res.json()) as {
    data: { id: string; rotationId: string };
  };
  return { rotationId: data.rotationId, scheduleId: data.id };
}

beforeAll(async () => {
  await db.insert(tenants).values([
    { id: TENANT_A, name: "RotApi A", slug: `rotapi-a-${TENANT_A}` },
    { id: TENANT_B, name: "RotApi B", slug: `rotapi-b-${TENANT_B}` },
  ]);
  await db.insert(tenantUsers).values(
    [ADMIN_A, ASHA, BEN].map((userId) => ({
      tenantId: TENANT_A,
      userId,
      email: `${userId}@example.com`,
      displayName: userId,
    })),
  );
});

afterAll(async () => {
  const both = [TENANT_A, TENANT_B];
  await db
    .delete(onCallSchedules)
    .where(inArray(onCallSchedules.tenantId, both));
  await db
    .delete(onCallRotations)
    .where(inArray(onCallRotations.tenantId, both));
  await db.delete(teamMembers).where(inArray(teamMembers.tenantId, both));
  await db.delete(teams).where(inArray(teams.tenantId, both));
  await db.delete(tenantUsers).where(inArray(tenantUsers.tenantId, both));
  await db.delete(tenants).where(inArray(tenants.id, both));
});

describe("creating a repeating roster (R4)", () => {
  it("creates the first window and one rotation tied to it, with the cursor after the first window", async () => {
    const teamId = await newTeam([ASHA, BEN]);
    const { rotationId, scheduleId } = await createRotation(teamId);
    const [rotation] = await db
      .select()
      .from(onCallRotations)
      .where(eq(onCallRotations.id, rotationId));
    expect(rotation).toMatchObject({
      teamId,
      cycleDays: 7,
      status: "active",
      lastPrimaryUserId: ASHA,
      lastBackupUserId: BEN,
      createdBy: ADMIN_A,
    });
    expect(rotation!.nextStartsAt).toEqual(new Date("2032-01-12T00:00:00Z"));
    const [window] = await db
      .select()
      .from(onCallSchedules)
      .where(eq(onCallSchedules.id, scheduleId));
    expect(window!.rotationId).toBe(rotationId);
  });

  it("refuses a second active rotation for the same team with 409", async () => {
    const teamId = await newTeam([ASHA, BEN]);
    await createRotation(teamId);
    const res = await appA.request(
      "/admin/on-call-schedules",
      send(
        "POST",
        windowBody(teamId, {
          startsAt: "2032-02-05T00:00:00Z",
          endsAt: "2032-02-12T00:00:00Z",
          repeat: { cycleDays: 7 },
        }),
      ),
    );
    expect(res.status).toBe(409);
  });

  it("refuses a repeating roster for a team with no members and writes nothing", async () => {
    const teamId = await newTeam([]);
    const res = await appA.request(
      "/admin/on-call-schedules",
      send("POST", windowBody(teamId, { repeat: { cycleDays: 7 } })),
    );
    expect(res.status).toBe(422);
    expect(
      await db
        .select()
        .from(onCallSchedules)
        .where(eq(onCallSchedules.teamId, teamId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(onCallRotations)
        .where(eq(onCallRotations.teamId, teamId)),
    ).toEqual([]);
  });

  it("makes a plain window with no rotation when repeat is off", async () => {
    const teamId = await newTeam([ASHA, BEN]);
    const res = await appA.request(
      "/admin/on-call-schedules",
      send("POST", windowBody(teamId)),
    );
    expect(res.status).toBe(201);
    expect(
      await db
        .select()
        .from(onCallRotations)
        .where(eq(onCallRotations.teamId, teamId)),
    ).toEqual([]);
  });
});

describe("managing a rotation (R9) and tenant isolation (R10)", () => {
  it("lists it with who is next, then stops, resumes and ends it", async () => {
    const teamId = await newTeam([ASHA, BEN]);
    const { rotationId } = await createRotation(teamId);

    const list = (await (
      await appA.request(`/admin/on-call-rotations?teamId=${teamId}`)
    ).json()) as { data: { id: string; nextPrimaryUserId: string }[] };
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({
      id: rotationId,
      nextPrimaryUserId: BEN,
    });

    const patch = (body: object): Promise<Response> =>
      appA.request(
        `/admin/on-call-rotations/${rotationId}`,
        send("PATCH", body),
      );
    expect((await patch({ status: "stopped" })).status).toBe(200);
    expect((await patch({ status: "active" })).status).toBe(200);
    expect((await patch({ endsOn: "2032-06-30" })).status).toBe(200);
    const [row] = await db
      .select()
      .from(onCallRotations)
      .where(eq(onCallRotations.id, rotationId));
    expect(row).toMatchObject({ status: "active", endsOn: "2032-06-30" });
  });

  it("refuses to resume a stopped rotation when another is active for the team, or the team lost its members", async () => {
    const teamId = await newTeam([ASHA, BEN]);
    const { rotationId } = await createRotation(teamId);
    await appA.request(
      `/admin/on-call-rotations/${rotationId}`,
      send("PATCH", { status: "stopped" }),
    );
    // a new active rotation for the same team (window further out so nothing overlaps)
    const second = await appA.request(
      "/admin/on-call-schedules",
      send(
        "POST",
        windowBody(teamId, {
          startsAt: "2032-03-05T00:00:00Z",
          endsAt: "2032-03-12T00:00:00Z",
          repeat: { cycleDays: 7 },
        }),
      ),
    );
    expect(second.status).toBe(201);
    const resume = await appA.request(
      `/admin/on-call-rotations/${rotationId}`,
      send("PATCH", { status: "active" }),
    );
    expect(resume.status).toBe(409);

    const emptyTeam = await newTeam([ASHA]);
    const { rotationId: r2 } = await createRotation(emptyTeam, {
      backupUserId: undefined,
    });
    await appA.request(
      `/admin/on-call-rotations/${r2}`,
      send("PATCH", { status: "stopped" }),
    );
    await db.delete(teamMembers).where(eq(teamMembers.teamId, emptyTeam));
    expect(
      (
        await appA.request(
          `/admin/on-call-rotations/${r2}`,
          send("PATCH", { status: "active" }),
        )
      ).status,
    ).toBe(422);
  });

  it("DELETE stops the rotation and removes windows that have not started", async () => {
    const teamId = await newTeam([ASHA, BEN]);
    const { rotationId, scheduleId } = await createRotation(teamId);
    const res = await appA.request(
      `/admin/on-call-rotations/${rotationId}`,
      send("DELETE"),
    );
    expect(res.status).toBe(204);
    const [row] = await db
      .select()
      .from(onCallRotations)
      .where(eq(onCallRotations.id, rotationId));
    expect(row!.status).toBe("stopped");
    const windows = await db
      .select()
      .from(onCallSchedules)
      .where(eq(onCallSchedules.id, scheduleId));
    expect(windows).toHaveLength(0);
  });

  it("pausing keeps the window running now, frees the upcoming time for a new roster, and then the paused one cannot resume", async () => {
    const teamId = await newTeam([ASHA, BEN]);
    const running = await createRotation(teamId, {
      label: "Running",
      startsAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });
    const upcomingStart = new Date(Date.now() + 5 * 86_400_000);
    const upcoming = await appA.request(
      "/admin/on-call-schedules",
      send(
        "POST",
        windowBody(teamId, {
          label: "Manual next",
          startsAt: upcomingStart.toISOString(),
          endsAt: new Date(
            upcomingStart.getTime() + 7 * 86_400_000,
          ).toISOString(),
        }),
      ),
    );
    expect(upcoming.status).toBe(201);
    const { data: nextWindow } = (await upcoming.json()) as {
      data: { id: string };
    };
    // make the next window part of the rotation, as the worker would have
    await db
      .update(onCallSchedules)
      .set({ rotationId: running.rotationId })
      .where(eq(onCallSchedules.id, nextWindow.id));

    const pause = await appA.request(
      `/admin/on-call-rotations/${running.rotationId}`,
      send("PATCH", { status: "stopped" }),
    );
    expect(pause.status).toBe(200);

    const left = await db
      .select({ id: onCallSchedules.id })
      .from(onCallSchedules)
      .where(eq(onCallSchedules.rotationId, running.rotationId));
    expect(left.map((w) => w.id)).toEqual([running.scheduleId]);
    const [rotation] = await db
      .select()
      .from(onCallRotations)
      .where(eq(onCallRotations.id, running.rotationId));
    expect(rotation!.nextStartsAt.getTime()).toBe(upcomingStart.getTime());

    // the freed time can take a new repeating roster
    const replacement = await appA.request(
      "/admin/on-call-schedules",
      send(
        "POST",
        windowBody(teamId, {
          label: "Replacement",
          startsAt: upcomingStart.toISOString(),
          endsAt: new Date(
            upcomingStart.getTime() + 7 * 86_400_000,
          ).toISOString(),
          repeat: { cycleDays: 7 },
        }),
      ),
    );
    expect(replacement.status).toBe(201);

    // only one roster runs at a time for a team
    const resume = await appA.request(
      `/admin/on-call-rotations/${running.rotationId}`,
      send("PATCH", { status: "active" }),
    );
    expect(resume.status).toBe(409);
  });

  it("shortening a running window re-plans the rotation: cycle, next start, and later windows", async () => {
    const teamId = await newTeam([ASHA, BEN]);
    const start = new Date(Date.now() - 86_400_000);
    start.setMilliseconds(0);
    const running = await createRotation(teamId, {
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 7 * 86_400_000).toISOString(),
    });
    // the worker already made the next window
    const nextStart = new Date(start.getTime() + 7 * 86_400_000);
    const [next] = await db
      .insert(onCallSchedules)
      .values({
        tenantId: TENANT_A,
        teamId,
        rotationId: running.rotationId,
        label: "Rotation next",
        startsAt: nextStart,
        endsAt: new Date(nextStart.getTime() + 7 * 86_400_000),
        primaryUserId: BEN,
        backupUserId: ASHA,
        createdBy: ADMIN_A,
      })
      .returning();

    const newEnd = new Date(start.getTime() + 3 * 86_400_000);
    const res = await appA.request(
      `/admin/on-call-schedules/${running.scheduleId}`,
      send("PATCH", { endsAt: newEnd.toISOString() }),
    );
    expect(res.status).toBe(200);

    const [rotation] = await db
      .select()
      .from(onCallRotations)
      .where(eq(onCallRotations.id, running.rotationId));
    expect(rotation).toMatchObject({ cycleDays: 3 });
    expect(rotation!.nextStartsAt.getTime()).toBe(newEnd.getTime());
    const gone = await db
      .select({ id: onCallSchedules.id })
      .from(onCallSchedules)
      .where(eq(onCallSchedules.id, next!.id));
    expect(gone).toHaveLength(0);

    const list = (await (
      await appA.request(`/admin/on-call-rotations?teamId=${teamId}`)
    ).json()) as {
      data: { projected: { startsAt: string; endsAt: string }[] }[];
    };
    const first = list.data[0]!.projected[0]!;
    expect(new Date(first.startsAt).getTime()).toBe(newEnd.getTime());
    expect(
      new Date(first.endsAt).getTime() - new Date(first.startsAt).getTime(),
    ).toBe(3 * 86_400_000);
  });

  it("editing a later window leaves earlier unstarted windows alone, and a longer end replaces the next window", async () => {
    const teamId = await newTeam([ASHA, BEN]);
    const DAY = 86_400_000;
    const base = new Date(Date.now() + 2 * DAY);
    base.setMilliseconds(0);
    const first = await createRotation(teamId, {
      label: "W1",
      startsAt: base.toISOString(),
      endsAt: new Date(base.getTime() + 7 * DAY).toISOString(),
    });
    const addWindow = async (label: string, startMs: number) => {
      const [row] = await db
        .insert(onCallSchedules)
        .values({
          tenantId: TENANT_A,
          teamId,
          rotationId: first.rotationId,
          label,
          startsAt: new Date(startMs),
          endsAt: new Date(startMs + 7 * DAY),
          primaryUserId: BEN,
          backupUserId: ASHA,
          createdBy: ADMIN_A,
        })
        .returning();
      return row!;
    };
    const w2 = await addWindow("W2", base.getTime() + 7 * DAY);
    const w3 = await addWindow("W3", base.getTime() + 14 * DAY);

    // lengthen W2 across W3's start: W3 goes, W1 stays
    const newEnd = new Date(w2.startsAt.getTime() + 10 * DAY);
    const res = await appA.request(
      `/admin/on-call-schedules/${w2.id}`,
      send("PATCH", { endsAt: newEnd.toISOString() }),
    );
    expect(res.status).toBe(200);

    const left = await db
      .select({ label: onCallSchedules.label })
      .from(onCallSchedules)
      .where(eq(onCallSchedules.rotationId, first.rotationId))
      .orderBy(asc(onCallSchedules.startsAt));
    expect(left.map((w) => w.label)).toEqual(["W1", "W2"]);
    expect(w3.id).toBeTruthy();
    const [rotation] = await db
      .select()
      .from(onCallRotations)
      .where(eq(onCallRotations.id, first.rotationId));
    expect(rotation!.nextStartsAt.getTime()).toBe(newEnd.getTime());
  });

  it("refuses an end before the start with 422 and changes nothing", async () => {
    const teamId = await newTeam([ASHA, BEN]);
    const { scheduleId } = await createRotation(teamId);
    const before = await db
      .select()
      .from(onCallSchedules)
      .where(eq(onCallSchedules.id, scheduleId));
    const res = await appA.request(
      `/admin/on-call-schedules/${scheduleId}`,
      send("PATCH", { endsAt: "2020-01-01T00:00:00Z" }),
    );
    expect(res.status).toBe(422);
    const after = await db
      .select()
      .from(onCallSchedules)
      .where(eq(onCallSchedules.id, scheduleId));
    expect(after[0]!.endsAt).toEqual(before[0]!.endsAt);
  });

  it("another tenant cannot list, change or stop a rotation, and it is unchanged", async () => {
    const teamId = await newTeam([ASHA, BEN]);
    const { rotationId } = await createRotation(teamId);

    const list = (await (
      await appB.request("/admin/on-call-rotations")
    ).json()) as {
      data: { id: string }[];
    };
    expect(list.data.some((r) => r.id === rotationId)).toBe(false);
    expect(
      (
        await appB.request(
          `/admin/on-call-rotations/${rotationId}`,
          send("PATCH", { status: "stopped" }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await appB.request(
          `/admin/on-call-rotations/${rotationId}`,
          send("DELETE"),
        )
      ).status,
    ).toBe(404);
    const [row] = await db
      .select()
      .from(onCallRotations)
      .where(eq(onCallRotations.id, rotationId));
    expect(row!.status).toBe("active");
  });

  it("RLS hides another tenant's rotations even without the explicit filter", async () => {
    const teamId = await newTeam([ASHA]);
    const { rotationId } = await createRotation(teamId, {
      backupUserId: undefined,
    });
    const seenByB = await withTenantContext(TENANT_B, (tx) =>
      tx
        .select()
        .from(onCallRotations)
        .where(eq(onCallRotations.id, rotationId)),
    );
    expect(seenByB).toEqual([]);
  });

  it("refuses a bad cycle length or end date with 400", async () => {
    const teamId = await newTeam([ASHA, BEN]);
    for (const cycleDays of [2, 91]) {
      const res = await appA.request(
        "/admin/on-call-schedules",
        send("POST", windowBody(teamId, { repeat: { cycleDays } })),
      );
      expect(res.status).toBe(400);
    }
    const { rotationId } = await createRotation(teamId);
    const bad = await appA.request(
      `/admin/on-call-rotations/${rotationId}`,
      send("PATCH", { endsOn: "not-a-date" }),
    );
    expect(bad.status).toBe(400);
  });
});
