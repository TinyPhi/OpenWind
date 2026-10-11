import { writeAuditEntry } from "@platform/audit";

type AuditDb = Parameters<typeof writeAuditEntry>[0];

export type AccessEntrySnapshot = { level: string; tag: string } | null;

export type AuditAccessChangeInput = {
  tenantId: string;
  actorId: string;
  instanceId: string;
  targetUserId: string;
  before: AccessEntrySnapshot;
  after: AccessEntrySnapshot;
  via: "direct" | "access_request";
  requestId?: string;
  unassigned?: boolean;
};

/**
 * Records a per-ticket ACL change (#640). Writes nothing when the entry is
 * unchanged (same level and tag). Call it on the same transaction as
 * the `__accessUsers` write so the change and its audit entry commit or roll
 * back together. `before` comes from the row the handler read earlier, so
 * under a concurrent edit it can be stale; `after`, the actor and the target
 * are exact.
 */
export async function auditAccessChange(
  tx: AuditDb,
  input: AuditAccessChangeInput,
): Promise<void> {
  const { before, after } = input;
  if (
    before !== null &&
    after !== null &&
    before.level === after.level &&
    before.tag === after.tag
  ) {
    return;
  }

  const action = !input.after
    ? "access.revoked"
    : input.before
      ? "access.updated"
      : "access.granted";

  await writeAuditEntry(tx, {
    tenantId: input.tenantId,
    actorId: input.actorId,
    actorType: "user",
    resourceType: "ticket",
    resourceId: input.instanceId,
    action,
    beforeSnapshot: input.before,
    afterSnapshot: input.after,
    metadata: {
      targetUserId: input.targetUserId,
      via: input.via,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.unassigned ? { unassigned: true } : {}),
    },
  });
}

/** Reads one user's entry out of an `__accessUsers` map, tolerating the legacy array shape. */
export function readAccessEntry(
  fields: unknown,
  userId: string,
): AccessEntrySnapshot {
  const map = (fields as { __accessUsers?: unknown } | null)?.__accessUsers;
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const entry = (map as Record<string, { level?: unknown; tag?: unknown }>)[
    userId
  ];
  if (!entry || typeof entry.level !== "string") return null;
  return {
    level: entry.level,
    tag: typeof entry.tag === "string" ? entry.tag : "manual",
  };
}
