import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { eq, and, inArray, isNull } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import {
  files,
  tenantUsers,
  apiKeys,
  teams,
  db,
  withTenantContext,
} from "@platform/db";
import {
  createEntity,
  TicketSeveritySchema,
  DEFAULT_TICKET_SEVERITY,
} from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { listUserIdsWithRole } from "../../lib/zitadel-management.js";
import { ensureUserRefsKnown } from "../../lib/ensure-user-refs.js";
import { postRemarkComment } from "../../lib/post-remark-comment.js";
import { logger } from "@platform/logger";

const CreateEntitySchema = z
  .object({
    entityTypeId: z.string().uuid(),
    fields: z.record(z.unknown()),
    // Mandatory platform-wide invariant on every creation path (admin-ui here,
    // third-party/tickets.ts, third-party/children.ts) -- title and dueDate
    // are required on every ticket, on every workflow, no exceptions.
    // assignedTo/teamId are each optional individually but exactly one of the
    // two must be present -- docs/specs/team-assign-oncall-fallback.md R1.
    // Previously optional here even though the admin-ui form already blocked
    // submission without them client-side -- trivially bypassed by any direct
    // API call. Not a per-workflow toggle like a workflow's own custom
    // entity_fields.
    assignedTo: z.string().min(1).optional(),
    // docs/specs/team-assign-oncall-fallback.md R1/R3 -- alternative to
    // assignedTo. Resolved asynchronously to an on-call user (or a fallback
    // tier) by the existing entity.created -> resolve_oncall automation
    // pipeline; never resolved synchronously in this request. Written into
    // fields.team_id below (the JSONB slot resolve-oncall.ts already reads),
    // not a new entity_instances column.
    teamId: z.string().min(1).optional(),
    dueDate: z.string().datetime(),
    remark: z.string().trim().min(1).max(4000),
    workflowId: z.string().uuid().optional(),
    currentState: z.string().optional(),
    // docs/specs/ticket-severity-and-tags.md R1 — optional on the wire; the
    // handler below defaults to Medium when omitted. Never NULL once past
    // this route (§V).
    severity: TicketSeveritySchema.optional(),
    // docs/specs/hosted-ticket-create-handoff.md R7 / third-party-api-origin-
    // tagging.md R2 — set ONLY when this create request arrives via the hosted
    // handoff flow (apps/admin-ui/src/pages/customer/record-create.tsx, threaded
    // from callback.tsx's state). Absent entirely on every normal, direct in-app
    // creation — those are never origin-tagged, by design (spec §V). When
    // present it is NOT trusted at face value: it must resolve to a real,
    // active, non-revoked api_keys row below, or creation is rejected outright.
    appClientId: z.string().trim().min(1).optional(),
  })
  .superRefine((input, ctx) => {
    // docs/specs/team-assign-oncall-fallback.md R1 — exactly one of
    // assignedTo/teamId, enforced server-side regardless of client behavior
    // (§V — never trust the toggle UI alone).
    const hasAssignedTo = input.assignedTo !== undefined;
    const hasTeamId = input.teamId !== undefined;
    if (hasAssignedTo && hasTeamId) {
      // Both set — attribute to teamId (the field whose presence conflicts
      // with an otherwise-valid assignedTo), not the field that's actually
      // fine on its own (/review finding, 2026-09-21).
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one of assignedTo or teamId must be set, not both",
        path: ["teamId"],
      });
    } else if (!hasAssignedTo && !hasTeamId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one of assignedTo or teamId must be set",
        path: ["assignedTo"],
      });
    }
  });

/**
 * docs/specs/hosted-ticket-create-handoff.md R7 — the handoff URL's
 * appClientId param must resolve to a real, active, non-revoked api_keys row
 * before a ticket created through that flow can be tagged with it. Runs on
 * the bare `db` client (not withTenantContext) for the same reason
 * create.ts's own Client-ID uniqueness check does (see that file's comment):
 * a Zitadel Client ID identifies one external application, not one tenant's
 * registration of it, and the caller doesn't know the resolved tenant yet at
 * this point in the flow.
 */
// PR #556 review (PrabhuVijit) — must filter by tenantId. Unlike
// resolveOriginOidcClientId (which looks up the authenticating key's own,
// already-trusted client id), the caller supplies this appClientId directly
// in the request body with no prior proof it belongs to their tenant.
// Without this filter, a Tenant A caller who knows Tenant B's oidcClientId
// could pass validation and tag their own ticket with Tenant B's
// application name (false attribution across tenants).
async function isValidActiveAppClientId(
  tenantId: string,
  oidcClientId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.tenantId, tenantId),
        eq(apiKeys.oidcClientId, oidcClientId),
        eq(apiKeys.oidcClientIdActive, true),
        isNull(apiKeys.revokedAt),
      ),
    )
    .limit(1);
  return !!row;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A file/files-type custom field's value is uploaded before this entity
// exists, so it can only ever reach the API as a bare id string - never
// bound (files.entityId) to anything yet. Rather than looking up the entity
// type's field definitions to find which fields are file-typed, just collect
// every UUID-shaped string value (top-level or inside an array) as a
// candidate; the DB-side WHERE guards below (unbound + same tenant + same
// uploader) mean a false positive - some unrelated field that merely happens
// to hold a UUID-shaped string - simply matches no file row and is a no-op.
function collectFileIdCandidates(fields: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const v of Object.values(fields)) {
    if (typeof v === "string" && UUID_RE.test(v)) out.push(v);
    else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string" && UUID_RE.test(item)) out.push(item);
      }
    }
  }
  return out;
}

export const createEntityHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", CreateEntitySchema),
  async (c) => {
    const { tenantId, userId, orgId } = c.get("auth");
    const input = c.req.valid("json");

    // assignedTo must resolve to a real tenant member holding the "user" role —
    // the same pool GET /platform/users exposes. Role membership is Zitadel-side
    // (tenant_users has no role column), scoped by orgId, so this also rejects a
    // cross-tenant user id (they simply won't appear in this org's role set).
    // Fail closed (no orgId → reject) rather than silently skipping the check.
    // Only runs when assignedTo was set -- CreateEntitySchema's superRefine
    // guarantees it's the mutually-exclusive alternative to teamId, not that
    // it's always present (docs/specs/team-assign-oncall-fallback.md R1).
    if (input.assignedTo !== undefined) {
      const usersWithRole = orgId
        ? await listUserIdsWithRole(orgId, "user")
        : new Set<string>();
      if (!usersWithRole.has(input.assignedTo)) {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: "Validation failed",
            fields: {
              assignedTo:
                "Must be an existing tenant member with the 'user' role",
            },
          },
          422,
        );
      }
    }

    // docs/specs/team-assign-oncall-fallback.md R1 — teamId must resolve to a
    // real team in the caller's own tenant. resolve_oncall's own schedule
    // lookup is already tenant-scoped and would silently no-op (fail open to
    // the workflow-admin fallback) on a bogus/cross-tenant id, so this isn't
    // closing a cross-tenant leak -- it's failing fast with a clear 422
    // instead of creating a ticket that's silently unresolvable.
    if (input.teamId !== undefined) {
      const [team] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({ id: teams.id })
          .from(teams)
          .where(
            and(
              eq(teams.id, input.teamId as string),
              eq(teams.tenantId, tenantId),
              isNull(teams.deletedAt),
            ),
          )
          .limit(1),
      );
      if (!team) {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: "Validation failed",
            fields: {
              teamId: "Must be an existing team in this tenant",
            },
          },
          422,
        );
      }
    }

    // docs/specs/hosted-ticket-create-handoff.md R7 — reject outright, never
    // silently create untagged, when the caller sent an appClientId that
    // doesn't resolve. Checked before any other work so a bad handoff
    // identity can't leave a partially-processed side effect behind.
    if (input.appClientId !== undefined) {
      const valid = await isValidActiveAppClientId(tenantId, input.appClientId);
      if (!valid) {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: "Validation failed",
            fields: {
              appClientId:
                "Does not resolve to a real, active, registered application",
            },
          },
          422,
        );
      }
    }

    try {
      const [dbUser] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            displayName: tenantUsers.displayName,
            email: tenantUsers.email,
          })
          .from(tenantUsers)
          .where(
            and(
              eq(tenantUsers.userId, userId),
              eq(tenantUsers.tenantId, tenantId),
            ),
          )
          .limit(1),
      );
      const actorName =
        dbUser?.displayName && dbUser.displayName !== userId
          ? dbUser.displayName
          : dbUser?.email && dbUser.email !== userId
            ? dbUser.email
            : null;

      const instance = await withTenantContext(tenantId, async (tx) => {
        // Upsert tenant_users for any user_ref field referencing a genuine
        // org member who hasn't logged into this app yet - otherwise
        // createEntity's own validateUserRefs (tenant_users-only) wrongly
        // rejects them. Must run inside this same transaction, before
        // createEntity, so its validation sees the freshly-inserted rows.
        await ensureUserRefsKnown(
          tx,
          tenantId,
          input.entityTypeId,
          input.fields,
          orgId,
        );
        // teamId isn't a createEntity field -- it's written into
        // fields.team_id (docs/specs/team-assign-oncall-fallback.md R1/§I),
        // the same JSONB slot the (previously dormant) resolve_oncall
        // automation rule already reads.
        const { appClientId, teamId, fields, ...createInput } = input;
        return createEntity(tx, tenantId, {
          ...createInput,
          fields:
            teamId !== undefined ? { ...fields, team_id: teamId } : fields,
          severity: createInput.severity ?? DEFAULT_TICKET_SEVERITY,
          actorId: userId,
          actorName: actorName ?? undefined,
          createdBy: userId,
          // appClientId was already validated above (or is undefined, the
          // normal non-handoff case) — every third-party-origin-tagging.md
          // §V branch here is set together or not at all, matching the
          // migration 0091 DB CHECK.
          ...(appClientId
            ? {
                originMechanism: "handoff" as const,
                originOidcClientId: appClientId,
                originPerformerUserId: userId,
              }
            : {}),
        });
      });

      // Link any file/files custom-field values uploaded before this entity
      // existed - otherwise GET /entities/:id/attachments (which filters on
      // files.entity_id) never finds them and the UI shows nothing for
      // those fields despite the entity's fields JSON holding valid ids.
      const fileIdCandidates = collectFileIdCandidates(input.fields);
      if (fileIdCandidates.length > 0) {
        await withTenantContext(tenantId, (tx) =>
          tx
            .update(files)
            .set({ entityId: instance.id })
            .where(
              and(
                inArray(files.id, fileIdCandidates),
                eq(files.tenantId, tenantId),
                eq(files.uploadedBy, userId),
                isNull(files.entityId),
              ),
            ),
        );
      }

      // Best-effort, outside the create transaction (already committed by
      // this point) -- a failure here must never surface as a failed ticket
      // creation. See post-remark-comment.ts.
      if (instance.workflowId) {
        try {
          await withTenantContext(tenantId, (tx) =>
            postRemarkComment(tx, {
              tenantId,
              instanceId: instance.id,
              workflowId: instance.workflowId as string,
              currentState: instance.currentState,
              actorId: userId,
              actorName: actorName ?? undefined,
              text: input.remark,
            }),
          );
        } catch (remarkErr) {
          logger.warn(
            { remarkErr, tenantId, instanceId: instance.id },
            "entity create: failed to post remark as first comment",
          );
        }
      }

      return c.json({ data: instance }, 201);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
