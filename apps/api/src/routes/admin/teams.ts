/**
 * Admin Teams CRUD — docs/specs/oncall-routing.md T7, R3, R13.
 *
 * Read (GET) allows agent + admin + user (docs/specs/team-assign-oncall-fallback.md
 * R1 — the customer-facing ticket-creation form, reachable by plain "user"
 * role, needs this to populate its Team assign-mode picker; read-only, no
 * data exposed beyond team name/id that agent/admin already see). Write
 * (POST/PATCH/DELETE) remains admin-only.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { and, asc, eq, gt, inArray, ne, or, isNull } from "drizzle-orm";
import type { AuthContext } from "@platform/auth";
import { requireAuth, requireRole } from "@platform/auth";
import type { DbOrTx } from "@platform/db";
import { db, withTenantContext, teams, teamMembers } from "@platform/db";
import { replaceTeamMembers } from "@platform/teams";
import { writeAuditEntry } from "@platform/audit";
import { logger } from "@platform/logger";
import {
  checkPeopleAreOnCall,
  peopleCheckResponse,
} from "../../lib/oncall-people.js";

type Vars = { Variables: { auth: AuthContext } };

const router = new Hono<Vars>();

router.use("*", requireAuth(db));

const TeamIdParamSchema = z.object({ id: z.guid() });

const ListTeamsQuerySchema = z.object({
  cursor: z.guid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// Also set in apps/admin-ui/src/pages/teams/index.tsx, which cannot import @platform/teams.
const MAX_TEAM_MEMBERS = 100;

class TeamChangedError extends Error {}

// The refuseBadMembers check and the write are separate transactions, so two admins adding the same
// person to two teams at once both pass it; the unique index is what stops the second.
function isOneTeamViolation(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("cause" in err)) return false;
  const cause = err.cause;
  return (
    !!cause &&
    typeof cause === "object" &&
    "code" in cause &&
    cause.code === "23505" &&
    "constraint_name" in cause &&
    cause.constraint_name === "team_members_tenant_user_unique"
  );
}

function oneTeamViolationResponse(c: Context<Vars>): Response {
  return c.json(
    {
      error: "VALIDATION_ERROR",
      message: "Validation failed",
      fields: [
        {
          field: "memberUserIds",
          message:
            "Someone in this list was just added to another team. Reload and try again.",
        },
      ],
    },
    422,
  );
}

const MemberUserIdsSchema = z
  .array(z.string().trim().min(1).max(255))
  .max(MAX_TEAM_MEMBERS);

const CreateTeamSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  memberUserIds: MemberUserIdsSchema.optional(),
});

const UpdateTeamSchema = CreateTeamSchema.omit({
  memberUserIds: true,
}).partial();

const SetMembersSchema = z.object({ memberUserIds: MemberUserIdsSchema });

type TeamMember = { userId: string; position: number };

async function loadMembers(
  tx: DbOrTx,
  tenantId: string,
  teamIds: string[],
): Promise<Map<string, TeamMember[]>> {
  const byTeam = new Map<string, TeamMember[]>();
  if (teamIds.length === 0) return byTeam;
  const rows = await tx
    .select({
      teamId: teamMembers.teamId,
      userId: teamMembers.userId,
      position: teamMembers.position,
    })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.tenantId, tenantId),
        inArray(teamMembers.teamId, teamIds),
      ),
    )
    .orderBy(asc(teamMembers.position));
  for (const r of rows) {
    const list = byTeam.get(r.teamId) ?? [];
    list.push({ userId: r.userId, position: r.position });
    byTeam.set(r.teamId, list);
  }
  return byTeam;
}

// Duplicate and eligibility checks for a submitted member list. Returns the
// refusal response, or null when the list is acceptable. Runs before any
// transaction opens (the Zitadel lookup must not hold a connection, #952). That
// leaves two accepted windows: a role revoked at Zitadel after the check is not
// seen by the write, and the next schedule create or patch re-checks membership
// anyway; and the list of current members used to skip people already on the
// team is re-checked against the locked rows by the PUT handler below.
async function refuseBadMembers(
  c: Context<Vars>,
  auth: AuthContext,
  memberUserIds: string[],
  alreadyMembers: ReadonlySet<string> = new Set(),
  thisTeamId?: string,
): Promise<Response | null> {
  const seen = new Set<string>();
  const duplicates: { field: string; message: string }[] = [];
  memberUserIds.forEach((userId, i) => {
    if (seen.has(userId)) {
      duplicates.push({
        field: `memberUserIds[${i}]`,
        message: "This person is listed more than once",
      });
    }
    seen.add(userId);
  });
  if (duplicates.length > 0) {
    return c.json(
      {
        error: "VALIDATION_ERROR",
        message: "Validation failed",
        fields: duplicates,
      },
      422,
    );
  }
  // A person belongs to one team at a time: someone being added who is on another team is refused.
  const adding = memberUserIds.filter((userId) => !alreadyMembers.has(userId));
  if (adding.length > 0) {
    const taken = await withTenantContext(auth.tenantId, (tx) =>
      tx
        .select({ userId: teamMembers.userId, teamName: teams.name })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
        .where(
          and(
            eq(teamMembers.tenantId, auth.tenantId),
            eq(teams.tenantId, auth.tenantId),
            isNull(teams.deletedAt),
            inArray(teamMembers.userId, adding),
            ...(thisTeamId ? [ne(teams.id, thisTeamId)] : []),
          ),
        ),
    );
    if (taken.length > 0) {
      const byUser = new Map(taken.map((t) => [t.userId, t.teamName]));
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: "Validation failed",
          fields: memberUserIds.flatMap((userId, i) =>
            byUser.has(userId)
              ? [
                  {
                    field: `memberUserIds[${i}]`,
                    message: `Already a member of the team "${byUser.get(userId)}". Remove them there first.`,
                  },
                ]
              : [],
          ),
        },
        422,
      );
    }
  }
  // Only people being added need an on-call role today: someone already on the
  // team who has since lost theirs must not block every later edit.
  return peopleCheckResponse(
    c,
    await checkPeopleAreOnCall(
      auth,
      memberUserIds
        .map((userId, i) => ({ field: `memberUserIds[${i}]`, userId }))
        .filter((p) => !alreadyMembers.has(p.userId)),
    ),
  );
}

// GET /admin/teams
router.get(
  "/",
  requireRole("agent", "admin", "user"),
  zValidator("query", ListTeamsQuerySchema),
  async (c) => {
    const auth = c.get("auth");
    const { cursor, limit } = c.req.valid("query");

    try {
      const result = await withTenantContext(auth.tenantId, async (tx) => {
        const conditions = [
          eq(teams.tenantId, auth.tenantId),
          isNull(teams.deletedAt),
        ];
        if (cursor) {
          const [cursorRow] = await tx
            .select({ createdAt: teams.createdAt, id: teams.id })
            .from(teams)
            .where(and(eq(teams.id, cursor), eq(teams.tenantId, auth.tenantId)))
            .limit(1);
          if (cursorRow) {
            // id as tiebreaker (PR #590 review, B3): createdAt alone is not
            // unique -- two rows inserted in the same millisecond share an
            // identical createdAt, and a plain `gt(createdAt, cursor)` would
            // silently skip both on a burst insert.
            const cursorCondition = or(
              gt(teams.createdAt, cursorRow.createdAt),
              and(
                eq(teams.createdAt, cursorRow.createdAt),
                gt(teams.id, cursorRow.id),
              ),
            );
            if (cursorCondition) conditions.push(cursorCondition);
          }
        }
        const rows = await tx
          .select()
          .from(teams)
          .where(and(...conditions))
          .orderBy(teams.createdAt, teams.id)
          .limit(limit + 1);

        const hasMore = rows.length > limit;
        const entries = hasMore ? rows.slice(0, limit) : rows;
        const nextCursor =
          hasMore && entries.length > 0
            ? (entries[entries.length - 1]?.id ?? null)
            : null;
        const members = await loadMembers(
          tx,
          auth.tenantId,
          entries.map((t) => t.id),
        );
        return {
          entries: entries.map((t) => ({
            ...t,
            members: members.get(t.id) ?? [],
          })),
          nextCursor,
        };
      });

      return c.json({
        data: result.entries,
        meta: {
          hasMore: result.nextCursor !== null,
          nextCursor: result.nextCursor,
        },
      });
    } catch (err: unknown) {
      logger.error({ err, tenantId: auth.tenantId }, "listTeams failed");
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// GET /admin/teams/:id
router.get(
  "/:id",
  requireRole("agent", "admin"),
  zValidator("param", TeamIdParamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");

    try {
      const row = await withTenantContext(auth.tenantId, async (tx) => {
        const [team] = await tx
          .select()
          .from(teams)
          .where(
            and(
              eq(teams.id, id),
              eq(teams.tenantId, auth.tenantId),
              isNull(teams.deletedAt),
            ),
          )
          .limit(1);
        if (!team) return undefined;
        const members = await loadMembers(tx, auth.tenantId, [team.id]);
        return { ...team, members: members.get(team.id) ?? [] };
      });

      if (!row) {
        return c.json({ error: "NOT_FOUND", message: "Team not found" }, 404);
      }
      return c.json({ data: row });
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, teamId: id },
        "getTeam failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// POST /admin/teams
router.post(
  "/",
  requireRole("admin"),
  zValidator("json", CreateTeamSchema),
  async (c) => {
    const auth = c.get("auth");
    const input = c.req.valid("json");
    const memberUserIds = input.memberUserIds ?? [];

    try {
      const refused = await refuseBadMembers(c, auth, memberUserIds);
      if (refused) return refused;
      const [row] = await withTenantContext(auth.tenantId, async (tx) => {
        const [inserted] = await tx
          .insert(teams)
          .values({
            tenantId: auth.tenantId,
            name: input.name,
            description: input.description,
            createdBy: auth.userId,
          })
          .returning();
        if (inserted) {
          await writeAuditEntry(tx, {
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorType: "user",
            resourceType: "team",
            resourceId: inserted.id,
            action: "created",
            afterSnapshot: {
              name: inserted.name,
              description: inserted.description,
              memberUserIds,
            },
          });
          await replaceTeamMembers(
            tx,
            auth.tenantId,
            inserted.id,
            memberUserIds,
          );
        }
        return [
          inserted && {
            ...inserted,
            members: memberUserIds.map((userId, position) => ({
              userId,
              position,
            })),
          },
        ] as const;
      });

      if (!row) {
        logger.error({ tenantId: auth.tenantId }, "createTeam returned no row");
        return c.json(
          { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
          500,
        );
      }
      return c.json({ data: row }, 201);
    } catch (err: unknown) {
      if (isOneTeamViolation(err)) return oneTeamViolationResponse(c);
      // Postgres unique_violation on teams_tenant_name_unique (R3: duplicate
      // name within a tenant returns 409).
      if (
        err &&
        typeof err === "object" &&
        "cause" in err &&
        err.cause &&
        typeof err.cause === "object" &&
        "code" in err.cause &&
        err.cause.code === "23505"
      ) {
        return c.json(
          {
            error: "CONFLICT",
            message: "A team with this name already exists",
          },
          409,
        );
      }
      logger.error({ err, tenantId: auth.tenantId }, "createTeam failed");
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// PATCH /admin/teams/:id
router.patch(
  "/:id",
  requireRole("admin"),
  zValidator("param", TeamIdParamSchema),
  zValidator("json", UpdateTeamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");

    try {
      const [row] = await withTenantContext(auth.tenantId, async (tx) => {
        const [before] = await tx
          .select()
          .from(teams)
          .where(and(eq(teams.id, id), eq(teams.tenantId, auth.tenantId)))
          .limit(1);
        const [updated] = await tx
          .update(teams)
          .set({ ...input, updatedAt: new Date() })
          .where(
            and(
              eq(teams.id, id),
              eq(teams.tenantId, auth.tenantId),
              isNull(teams.deletedAt),
            ),
          )
          .returning();
        if (updated) {
          await writeAuditEntry(tx, {
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorType: "user",
            resourceType: "team",
            resourceId: updated.id,
            action: "updated",
            beforeSnapshot: before
              ? { name: before.name, description: before.description }
              : null,
            afterSnapshot: {
              name: updated.name,
              description: updated.description,
            },
          });
        }
        return [updated] as const;
      });

      if (!row) {
        return c.json({ error: "NOT_FOUND", message: "Team not found" }, 404);
      }
      return c.json({ data: row });
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "cause" in err &&
        err.cause &&
        typeof err.cause === "object" &&
        "code" in err.cause &&
        err.cause.code === "23505"
      ) {
        return c.json(
          {
            error: "CONFLICT",
            message: "A team with this name already exists",
          },
          409,
        );
      }
      logger.error(
        { err, tenantId: auth.tenantId, teamId: id },
        "updateTeam failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// DELETE /admin/teams/:id — soft-delete (R3: preserves FK integrity on
// existing schedules/tickets referencing this team).
router.delete(
  "/:id",
  requireRole("admin"),
  zValidator("param", TeamIdParamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");

    try {
      const [row] = await withTenantContext(auth.tenantId, async (tx) => {
        const [before] = await tx
          .select({ name: teams.name })
          .from(teams)
          .where(and(eq(teams.id, id), eq(teams.tenantId, auth.tenantId)))
          .limit(1);
        // Membership is not history: a deleted team keeps no members.
        await tx
          .delete(teamMembers)
          .where(
            and(
              eq(teamMembers.teamId, id),
              eq(teamMembers.tenantId, auth.tenantId),
            ),
          );
        const [deleted] = await tx
          .update(teams)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(teams.id, id),
              eq(teams.tenantId, auth.tenantId),
              isNull(teams.deletedAt),
            ),
          )
          .returning({ id: teams.id });
        if (deleted) {
          await writeAuditEntry(tx, {
            tenantId: auth.tenantId,
            actorId: auth.userId,
            actorType: "user",
            resourceType: "team",
            resourceId: deleted.id,
            action: "deleted",
            beforeSnapshot: before ? { name: before.name } : null,
          });
        }
        return [deleted] as const;
      });

      if (!row) {
        return c.json({ error: "NOT_FOUND", message: "Team not found" }, 404);
      }
      return c.body(null, 204);
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, teamId: id },
        "deleteTeam failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

// PUT /admin/teams/:id/members -- replaces the ordered member list; positions
// come out contiguous from 0 so the rotation never steps over a gap.
router.put(
  "/:id/members",
  requireRole("admin"),
  zValidator("param", TeamIdParamSchema),
  zValidator("json", SetMembersSchema),
  async (c) => {
    const auth = c.get("auth");
    const { id } = c.req.valid("param");
    const { memberUserIds } = c.req.valid("json");

    try {
      // Look the team up first: a missing or other-tenant team is a plain 404
      // with no Zitadel call and no tenant_users side effect.
      const current = await withTenantContext(auth.tenantId, async (tx) => {
        const [exists] = await tx
          .select({ id: teams.id })
          .from(teams)
          .where(
            and(
              eq(teams.id, id),
              eq(teams.tenantId, auth.tenantId),
              isNull(teams.deletedAt),
            ),
          )
          .limit(1);
        if (!exists) return undefined;
        return (await loadMembers(tx, auth.tenantId, [id])).get(id) ?? [];
      });
      if (!current) {
        return c.json({ error: "NOT_FOUND", message: "Team not found" }, 404);
      }
      const alreadyChecked = new Set(current.map((m) => m.userId));
      const refused = await refuseBadMembers(
        c,
        auth,
        memberUserIds,
        alreadyChecked,
        id,
      );
      if (refused) return refused;
      const row = await withTenantContext(auth.tenantId, async (tx) => {
        const [team] = await tx
          .select()
          .from(teams)
          .where(
            and(
              eq(teams.id, id),
              eq(teams.tenantId, auth.tenantId),
              isNull(teams.deletedAt),
            ),
          )
          .limit(1);
        if (!team) return undefined;
        const previous = await replaceTeamMembers(
          tx,
          auth.tenantId,
          id,
          memberUserIds,
        );
        // The pre-check skipped people the team had when it ran. Anyone who left the team since
        // was skipped without being checked, so refuse and roll back instead of writing them.
        const nowOnTeam = new Set(previous);
        const unchecked = memberUserIds.filter(
          (u) => alreadyChecked.has(u) && !nowOnTeam.has(u),
        );
        if (unchecked.length > 0) throw new TeamChangedError();
        await writeAuditEntry(tx, {
          tenantId: auth.tenantId,
          actorId: auth.userId,
          actorType: "user",
          resourceType: "team",
          resourceId: id,
          action: "updated",
          beforeSnapshot: {
            memberUserIds: previous,
          },
          afterSnapshot: { memberUserIds },
        });
        return {
          ...team,
          members: memberUserIds.map((userId, position) => ({
            userId,
            position,
          })),
        };
      });

      if (!row) {
        return c.json({ error: "NOT_FOUND", message: "Team not found" }, 404);
      }
      return c.json({ data: row });
    } catch (err: unknown) {
      if (isOneTeamViolation(err)) return oneTeamViolationResponse(c);
      if (err instanceof TeamChangedError) {
        return c.json(
          {
            error: "CONFLICT",
            message: "The team changed while saving. Reload it and try again.",
          },
          409,
        );
      }
      logger.error(
        { err, tenantId: auth.tenantId, teamId: id },
        "setTeamMembers failed",
      );
      return c.json(
        { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
        500,
      );
    }
  },
);

export { router as teamsRouter };
