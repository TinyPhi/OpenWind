import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { eq, and, inArray, isNull } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import { files, tenantUsers, withTenantContext } from "@platform/db";
import { createEntity } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { listUserIdsWithRole } from "../../lib/zitadel-management.js";

const CreateEntitySchema = z.object({
  entityTypeId: z.string().uuid(),
  fields: z.record(z.unknown()),
  assignedTo: z.string().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  workflowId: z.string().uuid().optional(),
  currentState: z.string().optional(),
});

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

      const instance = await withTenantContext(tenantId, (tx) =>
        createEntity(tx, tenantId, {
          ...input,
          actorId: userId,
          actorName: actorName ?? undefined,
          createdBy: userId,
        }),
      );

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

      return c.json({ data: instance }, 201);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
