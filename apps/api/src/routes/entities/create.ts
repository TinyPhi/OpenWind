import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { eq, and, inArray, isNull } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import {
  files,
  tenantUsers,
  apiKeys,
  db,
  withTenantContext,
} from "@platform/db";
import { createEntity } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { listUserIdsWithRole } from "../../lib/zitadel-management.js";
import { ensureUserRefsKnown } from "../../lib/ensure-user-refs.js";

const CreateEntitySchema = z.object({
  entityTypeId: z.string().uuid(),
  fields: z.record(z.unknown()),
  assignedTo: z.string().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  workflowId: z.string().uuid().optional(),
  currentState: z.string().optional(),
  // docs/specs/hosted-ticket-create-handoff.md R7 / third-party-api-origin-
  // tagging.md R2 — set ONLY when this create request arrives via the hosted
  // handoff flow (apps/admin-ui/src/pages/customer/record-create.tsx, threaded
  // from callback.tsx's state). Absent entirely on every normal, direct in-app
  // creation — those are never origin-tagged, by design (spec §V). When
  // present it is NOT trusted at face value: it must resolve to a real,
  // active, non-revoked api_keys row below, or creation is rejected outright.
  appClientId: z.string().trim().min(1).optional(),
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
async function isValidActiveAppClientId(
  oidcClientId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
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

    // docs/specs/hosted-ticket-create-handoff.md R7 — reject outright, never
    // silently create untagged, when the caller sent an appClientId that
    // doesn't resolve. Checked before any other work so a bad handoff
    // identity can't leave a partially-processed side effect behind.
    if (input.appClientId !== undefined) {
      const valid = await isValidActiveAppClientId(input.appClientId);
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
        const { appClientId, ...createInput } = input;
        return createEntity(tx, tenantId, {
          ...createInput,
          actorId: userId,
          actorName: actorName ?? undefined,
          createdBy: userId,
          // appClientId was already validated above (or is undefined, the
          // normal non-handoff case) — every third-party-origin-tagging.md
          // §V branch here is set together or not at all, matching the
          // migration 0090 DB CHECK.
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

      return c.json({ data: instance }, 201);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
