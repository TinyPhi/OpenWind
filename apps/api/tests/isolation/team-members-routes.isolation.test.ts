/**
 * docs/specs/oncall-team-rotation.md R1, R3, R10: the team-member routes and the
 * "roles come from the team" rule, against a real Postgres through the real
 * routers. Zitadel is the only stand-in: each org lists only its own users, so a
 * user id from another org is "not on call" here, as in production.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import {
  db,
  tenants,
  tenantUsers,
  teams,
  teamMembers,
  onCallSchedules,
  withTenantContext,
} from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { teamsRouter } from "../../src/routes/admin/teams.js";
import { onCallSchedulesRouter } from "../../src/routes/admin/on-call-schedules.js";

const TENANT_A = "aaaaaaaa-1028-4000-a000-000000000011";
const TENANT_B = "bbbbbbbb-1028-4000-b000-000000000012";
const ORG_A = "org-members-a";
const ORG_B = "org-members-b";
const ADMIN_A = "u-members-admin-a";
const ASHA = "u-members-asha";
const BEN = "u-members-ben";
const CHEN = "u-members-chen";
const ADMIN_B = "u-members-admin-b";

vi.mock("../../src/lib/zitadel-management.js", () => ({
  listUserRolesByUserId: (orgId: string) =>
    Promise.resolve(
      orgId === "org-members-a"
        ? new Map<string, string[]>([
            ["u-members-admin-a", ["admin"]],
            ["u-members-asha", ["agent"]],
            ["u-members-ben", ["user"]],
            ["u-members-chen", ["user"]],
          ])
        : new Map<string, string[]>([["u-members-admin-b", ["admin"]]]),
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
  app.route("/admin/teams", teamsRouter);
  app.route("/admin/on-call-schedules", onCallSchedulesRouter);
  return app;
}

const appA = makeApp(TENANT_A, ORG_A, ADMIN_A);
const appB = makeApp(TENANT_B, ORG_B, ADMIN_B);

function json(body: unknown): {
  method: string;
  headers: Record<string, string>;
  body: string;
} {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function createTeam(
  name: string,
  memberUserIds: string[],
): Promise<string> {
  // A person is on one team at a time, and these tests reuse a few people, so free them first.
  await db
    .delete(teamMembers)
    .where(
      and(
        eq(teamMembers.tenantId, TENANT_A),
        inArray(teamMembers.userId, memberUserIds),
      ),
    );
  const res = await appA.request("/admin/teams", json({ name, memberUserIds }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

async function storedMembers(
  teamId: string,
): Promise<{ userId: string; position: number }[]> {
  return db
    .select({ userId: teamMembers.userId, position: teamMembers.position })
    .from(teamMembers)
    .where(
      and(eq(teamMembers.teamId, teamId), eq(teamMembers.tenantId, TENANT_A)),
    )
    .orderBy(asc(teamMembers.position));
}

beforeAll(async () => {
  await db.insert(tenants).values([
    { id: TENANT_A, name: "Members A", slug: `members-a-${TENANT_A}` },
    { id: TENANT_B, name: "Members B", slug: `members-b-${TENANT_B}` },
  ]);
  await db.insert(tenantUsers).values(
    [ADMIN_A, ASHA, BEN, CHEN].map((userId) => ({
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
  await db.delete(teamMembers).where(inArray(teamMembers.tenantId, both));
  await db.delete(teams).where(inArray(teams.tenantId, both));
  await db.delete(tenantUsers).where(inArray(tenantUsers.tenantId, both));
  await db.delete(tenants).where(inArray(tenants.id, both));
});

describe("team members — tenant isolation", () => {
  it("creates a team with ordered members and reads them back in order", async () => {
    const id = await createTeam("order-team", [BEN, ASHA, CHEN]);
    expect(await storedMembers(id)).toEqual([
      { userId: BEN, position: 0 },
      { userId: ASHA, position: 1 },
      { userId: CHEN, position: 2 },
    ]);
    const res = await appA.request(`/admin/teams/${id}`);
    const { data } = (await res.json()) as {
      data: { members: { userId: string }[] };
    };
    expect(data.members.map((m) => m.userId)).toEqual([BEN, ASHA, CHEN]);
  });

  it("a person can be on only one team: refused while on another, accepted once removed", async () => {
    const first = await createTeam("one-team-first", [ASHA]);
    const second = await createTeam("one-team-second", [BEN]);
    const refused = await appA.request(`/admin/teams/${second}/members`, {
      ...json({ memberUserIds: [BEN, ASHA] }),
      method: "PUT",
    });
    expect(refused.status).toBe(422);
    const body = (await refused.json()) as {
      fields: { field: string; message: string }[];
    };
    expect(body.fields[0]).toMatchObject({ field: "memberUserIds[1]" });
    expect(body.fields[0]!.message).toMatch(/one-team-first/);
    expect(await storedMembers(second)).toEqual([{ userId: BEN, position: 0 }]);

    // removed from the first team, ASHA is free for the second
    await appA.request(`/admin/teams/${first}/members`, {
      ...json({ memberUserIds: [] }),
      method: "PUT",
    });
    const accepted = await appA.request(`/admin/teams/${second}/members`, {
      ...json({ memberUserIds: [BEN, ASHA] }),
      method: "PUT",
    });
    expect(accepted.status).toBe(200);

    // a new team cannot take someone who is on another team either
    const create = await appA.request(
      "/admin/teams",
      json({ name: "one-team-third", memberUserIds: [ASHA] }),
    );
    expect(create.status).toBe(422);
  });

  it("another tenant cannot read, replace or list a team's members", async () => {
    const id = await createTeam("private-team", [ASHA, BEN]);

    expect((await appB.request(`/admin/teams/${id}`)).status).toBe(404);
    const put = await appB.request(`/admin/teams/${id}/members`, {
      ...json({ memberUserIds: [ADMIN_B] }),
      method: "PUT",
    });
    expect(put.status).toBe(404);
    expect(await storedMembers(id)).toEqual([
      { userId: ASHA, position: 0 },
      { userId: BEN, position: 1 },
    ]);

    const list = (await (await appB.request("/admin/teams")).json()) as {
      data: { id: string }[];
    };
    expect(list.data.some((t) => t.id === id)).toBe(false);
  });

  it("RLS hides another tenant's membership rows even without the explicit filter", async () => {
    const id = await createTeam("rls-team", [ASHA]);
    const seenByB = await withTenantContext(TENANT_B, (tx) =>
      tx.select().from(teamMembers).where(eq(teamMembers.teamId, id)),
    );
    expect(seenByB).toEqual([]);
  });

  it("refuses a user from another org without confirming they exist, and writes nothing", async () => {
    const id = await createTeam("cross-org-team", [ASHA]);
    const res = await appA.request(`/admin/teams/${id}/members`, {
      ...json({ memberUserIds: [ASHA, ADMIN_B] }),
      method: "PUT",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      fields: { field: string; message: string }[];
    };
    expect(body.fields).toEqual([
      expect.objectContaining({ field: "memberUserIds[1]" }),
    ]);
    expect(await storedMembers(id)).toEqual([{ userId: ASHA, position: 0 }]);
  });

  it("a failed create writes neither the team nor any member", async () => {
    const res = await appA.request(
      "/admin/teams",
      json({ name: "never-created", memberUserIds: [ASHA, ADMIN_B] }),
    );
    expect(res.status).toBe(422);
    const rows = await db
      .select()
      .from(teams)
      .where(
        and(eq(teams.tenantId, TENANT_A), eq(teams.name, "never-created")),
      );
    expect(rows).toEqual([]);
  });

  it("replacing the list renumbers positions from 0 with no gap", async () => {
    const id = await createTeam("renumber-team", [ASHA, BEN, CHEN]);
    const res = await appA.request(`/admin/teams/${id}/members`, {
      ...json({ memberUserIds: [CHEN, ASHA] }),
      method: "PUT",
    });
    expect(res.status).toBe(200);
    expect(await storedMembers(id)).toEqual([
      { userId: CHEN, position: 0 },
      { userId: ASHA, position: 1 },
    ]);
  });
});

describe("on-call schedules — roles come from the team's members", () => {
  const window = (n: number) => ({
    startsAt: `2031-0${n}-01T00:00:00Z`,
    endsAt: `2031-0${n}-08T00:00:00Z`,
  });

  it("refuses a non-member for any role and accepts members", async () => {
    const id = await createTeam("roster-team", [ASHA, BEN]);
    const refused = await appA.request(
      "/admin/on-call-schedules",
      json({
        teamId: id,
        label: "w1",
        ...window(1),
        primaryUserId: ASHA,
        backupUserId: CHEN,
      }),
    );
    expect(refused.status).toBe(422);
    expect(
      ((await refused.json()) as { fields: { field: string }[] }).fields,
    ).toEqual([expect.objectContaining({ field: "backupUserId" })]);

    const accepted = await appA.request(
      "/admin/on-call-schedules",
      json({
        teamId: id,
        label: "w1",
        ...window(1),
        primaryUserId: ASHA,
        backupUserId: BEN,
      }),
    );
    expect(accepted.status).toBe(201);
  });

  it("a window naming a former member stays editable until that role changes", async () => {
    const id = await createTeam("former-member-team", [ASHA, BEN]);
    const created = await appA.request(
      "/admin/on-call-schedules",
      json({
        teamId: id,
        label: "w2",
        ...window(2),
        primaryUserId: ASHA,
      }),
    );
    expect(created.status).toBe(201);
    const scheduleId = ((await created.json()) as { data: { id: string } }).data
      .id;

    await appA.request(`/admin/teams/${id}/members`, {
      ...json({ memberUserIds: [BEN] }),
      method: "PUT",
    });

    const patch = (body: object): Promise<Response> =>
      appA.request(`/admin/on-call-schedules/${scheduleId}`, {
        ...json(body),
        method: "PATCH",
      });
    expect((await patch({ label: "renamed" })).status).toBe(200);
    expect(
      (await patch({ label: "renamed2", primaryUserId: ASHA })).status,
    ).toBe(200);
    const changed = await patch({ primaryUserId: CHEN });
    expect(changed.status).toBe(422);
    expect((await patch({ primaryUserId: BEN })).status).toBe(200);
  });

  it("a team with no members still accepts any eligible user", async () => {
    const id = await createTeam("open-team", []);
    const res = await appA.request(
      "/admin/on-call-schedules",
      json({
        teamId: id,
        label: "w3",
        ...window(3),
        primaryUserId: CHEN,
      }),
    );
    expect(res.status).toBe(201);
  });
});
