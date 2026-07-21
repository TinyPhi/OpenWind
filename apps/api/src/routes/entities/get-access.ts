import { requireAuth } from "@platform/auth";
import { eq, and } from "drizzle-orm";
import { entityInstances, withTenantContext } from "@platform/db";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { hasEntityAccess } from "../../lib/entity-access.js";

type AccessLevel = "read_only" | "read_comment" | "read_write";
type AccessTag = "creator" | "assigned" | "mention" | "manual";

export interface AccessEntry {
  userId: string;
  level: AccessLevel;
  tag: AccessTag;
}

// Parse __accessUsers JSONB — handles both legacy string[] and new object map
function parseAccessUsers(
  raw: unknown,
): Record<string, { level: AccessLevel; tag: AccessTag }> {
  if (!raw || typeof raw !== "object") return {};
  if (Array.isArray(raw)) {
    // Legacy: string[] — treat all as read_comment mention
    return Object.fromEntries(
      (raw as string[]).map((uid) => [
        uid,
        { level: "read_comment" as AccessLevel, tag: "mention" as AccessTag },
      ]),
    );
  }
  return raw as Record<string, { level: AccessLevel; tag: AccessTag }>;
}

export const getAccessHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");

    try {
      const [instance, allowed] = await withTenantContext(
        tenantId,
        async (tx) => {
          const [row] = await tx
            .select({
              fields: entityInstances.fields,
              assignedTo: entityInstances.assignedTo,
              createdBy: entityInstances.createdBy,
              workflowId: entityInstances.workflowId,
            })
            .from(entityInstances)
            .where(
              and(
                eq(entityInstances.id, id),
                eq(entityInstances.tenantId, tenantId),
              ),
            )
            .limit(1);
          if (!row) return [undefined, false] as const;
          return [
            row,
            await hasEntityAccess(tx, tenantId, row, userId, roles),
          ] as const;
        },
      );

      if (!instance || !allowed) {
        return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
      }

      const fields = instance.fields as Record<string, unknown>;
      const map = parseAccessUsers(fields.__accessUsers);

      // Build the merged entry list
      const result: AccessEntry[] = [];
      const seen = new Set<string>();

      // Creator — always read_write, always first
      if (instance.createdBy) {
        seen.add(instance.createdBy);
        result.push({
          userId: instance.createdBy,
          level: "read_write",
          tag: "creator",
        });
      }

      // Assigned — always read_write
      if (instance.assignedTo && !seen.has(instance.assignedTo)) {
        seen.add(instance.assignedTo);
        result.push({
          userId: instance.assignedTo,
          level: "read_write",
          tag: "assigned",
        });
      } else if (instance.assignedTo && seen.has(instance.assignedTo)) {
        // Creator is also assigned — upgrade tag to show both; keep as creator
      }

      // Additional access from __accessUsers map
      for (const [uid, entry] of Object.entries(map)) {
        if (seen.has(uid)) continue;
        seen.add(uid);
        result.push({
          userId: uid,
          level: entry.level,
          tag: entry.tag,
        });
      }

      return c.json({ data: result });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
