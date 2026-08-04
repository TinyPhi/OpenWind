import { eq, and } from "drizzle-orm";
import { withTenantContext, entityInstances, entityTypes } from "@platform/db";

// Mirrors apps/admin-ui/src/entity-type-context.tsx's toTypeSlug exactly — the
// admin UI has no stored slug column, it derives one client-side from
// entity_types.name. Must stay byte-identical to that function or record
// links silently 404.
function toTypeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export async function buildRecordLink(
  tenantId: string,
  instanceId: string,
): Promise<string | null> {
  // entity_instances has RLS — must go through withTenantContext (see
  // notification-worker.ts's resolveActorName for the same reasoning).
  // entity_types itself has no RLS (nullable tenant_id — NULL denotes a
  // system/template row visible to every tenant), but the join is still
  // gated by entity_instances' own row visibility.
  const [row] = await withTenantContext(tenantId, (tx) =>
    tx
      .select({ typeName: entityTypes.name })
      .from(entityInstances)
      .innerJoin(entityTypes, eq(entityInstances.entityTypeId, entityTypes.id))
      .where(
        and(
          eq(entityInstances.id, instanceId),
          eq(entityInstances.tenantId, tenantId),
        ),
      )
      .limit(1),
  );

  if (!row) return null;
  return `/records/${toTypeSlug(row.typeName)}/${instanceId}`;
}

export interface NotificationContent {
  title: string;
  body: string;
  link: string | null;
}

// Fixed, hardcoded templates — not tenant-configurable (docs/specs/
// in-app-notification-hub.md). Never interpolate raw free-text user content
// (e.g. comment bodies) — only identifiers/names — to avoid leaking data
// through a channel with no read-access check of its own.
export async function buildNotificationContent(
  eventType: string,
  params: {
    tenantId: string;
    instanceId: string | undefined;
    actorName: string;
    reason: string | undefined;
  },
): Promise<NotificationContent> {
  const link = params.instanceId
    ? await buildRecordLink(params.tenantId, params.instanceId)
    : null;

  const sanitizeString = (str: unknown): string => {
    if (typeof str !== "string") return "";
    return str.replace(/[<>]/g, "");
  };

  const actorName = sanitizeString(params.actorName);
  const reason = sanitizeString(params.reason);

  switch (eventType) {
    case "entity.assigned":
      return {
        title: "New assignment",
        body: `${actorName} assigned you a ticket`,
        link,
      };
    case "comment.mentioned":
      return {
        title: "Comment mention",
        body: `${actorName} mentioned you in a comment`,
        link,
      };
    case "comment.mention_access_granted":
      return {
        title: "Access granted via mention",
        body: `${actorName} granted you access to this ticket via a comment mention`,
        link,
      };
    case "comment.replied":
      return {
        title: "New reply",
        body: `${actorName} replied to your comment`,
        link,
      };
    case "access.granted":
      return {
        title: "Access granted",
        body: `${actorName} granted you access to a ticket`,
        link,
      };
    case "access.revoked":
      return {
        title: "Access revoked",
        body: `${actorName} revoked your access to a ticket`,
        link,
      };
    case "workflow.sla_breached":
      return {
        title: "SLA breached",
        body: "A ticket in your workflow has breached its SLA",
        link,
      };
    case "system.error":
      return {
        title: "System error",
        body: reason || "A system error occurred",
        link: "/admin/system-logs",
      };
    default:
      // Unreachable given the poller's allowlist — fail loudly rather than
      // silently writing a blank notification if a new event type is ever
      // added to the allowlist without a matching template.
      throw new Error(`No notification template for event type: ${eventType}`);
  }
}
