/**
 * GDPR Art. 15/20 data-subject export (docs/specs/user-data-export.md, #642).
 *
 * Collects what OpenWind stores about one user in one tenant. The bundle is a
 * projection allow-list per table: a column is exported only if it is named in
 * the section below, so secrets (key hashes, connector credentials, upload
 * tokens, storage paths) cannot leak by being added to a table later.
 *
 * Must run inside withTenantContext for `tenantId`. Every query also filters on
 * tenant_id explicitly.
 */

import {
  and,
  asc,
  eq,
  getTableColumns,
  getTableName,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  type DbOrTx,
  adminAuditLog,
  accessRequests,
  apiKeys,
  attachments,
  connectorCredentials,
  entityInstances,
  entityInstanceTags,
  files,
  idempotencyKeys,
  labels,
  notificationPolicies,
  notificationRecipients,
  notifications,
  onCallSchedules,
  orgDirectorySyncRuns,
  orgEmployees,
  savedViews,
  scheduleRules,
  services,
  teams,
  tenantUsers,
  ticketAlerts,
  ticketLabels,
  workflowEvents,
  workflows,
} from "@platform/db";

type UserColumnSpec = { key: string; array?: true };

type SectionSpec = {
  /** Key of the section's rows in the bundle. */
  name: string;
  table: PgTable;
  /** Allow-list of exported columns (Drizzle property names). */
  keys: readonly string[];
  /** Columns that tie a row to the subject; a row matches if any does. */
  userColumns: readonly UserColumnSpec[];
  orderBy: string;
  /** RLS policy also requires user_id = app.user_id (saved_views). */
  userScopedRls?: true;
  transform?: (row: Record<string, unknown>) => Record<string, unknown>;
};

export type UserDataExportSectionRows = Record<string, unknown>[];

export type UserDataBundle = {
  metadata: {
    schemaVersion: 1;
    tenantId: string;
    subjectUserId: string;
    generatedAt: string;
    availableUntil: string | null;
    rowLimit: number;
    includeAudit: boolean;
    /** Sections cut at rowLimit. */
    truncated: string[];
    /** What is deliberately not in the bundle, and why. */
    exclusions: Record<string, string>;
  };
  data: Record<string, UserDataExportSectionRows>;
};

const BUNDLE_EXCLUSIONS: Readonly<Record<string, string>> = {
  zitadelProfile:
    "the live identity-provider profile is not stored by OpenWind; only the tenant_users row is included",
  fileContents:
    "attachment and file entries are a metadata manifest; file bytes are not included",
  recordsAuthoredByOthers:
    "records written by other people that merely mention or reference the subject are not the subject's data and are not included",
  secrets:
    "API key hashes, connector credentials, upload tokens and storage paths are never exported",
};

// Built on first use, not at import: many packages import the entity-engine with a
// partial @platform/db mock, and this file names a lot of tables.
let sectionsCache:
  | { sections: readonly SectionSpec[]; audit: SectionSpec }
  | undefined;

function buildSections(): {
  sections: readonly SectionSpec[];
  audit: SectionSpec;
} {
  return { sections: buildSectionList(), audit: buildAuditSection() };
}

function getSections(): {
  sections: readonly SectionSpec[];
  audit: SectionSpec;
} {
  sectionsCache ??= buildSections();
  return sectionsCache;
}

function buildSectionList(): readonly SectionSpec[] {
  return [
    {
      name: "tenantUsers",
      table: tenantUsers,
      keys: ["id", "userId", "email", "displayName", "createdAt"],
      userColumns: [{ key: "userId" }],
      orderBy: "id",
    },
    {
      name: "savedViews",
      table: savedViews,
      keys: [
        "id",
        "userId",
        "entityTypeId",
        "name",
        "filterConfig",
        "sortConfig",
        "isDefault",
        "createdAt",
        "updatedAt",
      ],
      userColumns: [{ key: "userId" }],
      orderBy: "id",
      userScopedRls: true,
    },
    {
      name: "notificationRecipients",
      table: notificationRecipients,
      keys: ["id", "notificationId", "userId", "readAt", "createdAt"],
      userColumns: [{ key: "userId" }],
      orderBy: "id",
    },
    {
      name: "ticketAlerts",
      table: ticketAlerts,
      keys: [
        "id",
        "instanceId",
        "createdBy",
        "note",
        "fireAt",
        "scope",
        "status",
        "firedAt",
        "createdAt",
      ],
      userColumns: [{ key: "createdBy" }],
      orderBy: "id",
    },
    {
      name: "accessRequests",
      table: accessRequests,
      keys: [
        "id",
        "instanceId",
        "requesterId",
        "requestedLevel",
        "status",
        "resolvedBy",
        "resolvedAt",
        "createdAt",
      ],
      userColumns: [{ key: "requesterId" }, { key: "resolvedBy" }],
      orderBy: "id",
    },
    {
      name: "apiKeys",
      table: apiKeys,
      keys: [
        "id",
        "name",
        "scopes",
        "createdBy",
        "createdAt",
        "expiresAt",
        "lastUsedAt",
        "revokedAt",
        "revokedBy",
      ],
      userColumns: [{ key: "createdBy" }, { key: "revokedBy" }],
      orderBy: "id",
    },
    {
      name: "entityInstances",
      table: entityInstances,
      keys: [
        "id",
        "entityTypeId",
        "workflowId",
        "currentState",
        "fields",
        "createdBy",
        "assignedTo",
        "originPerformerUserId",
        "createdAt",
        "updatedAt",
        "deletedAt",
        "dueDate",
        "severity",
        "remark",
      ],
      userColumns: [
        { key: "createdBy" },
        { key: "assignedTo" },
        { key: "originPerformerUserId" },
      ],
      orderBy: "id",
      // The access list holds other people's user ids.
      transform: (row) => {
        const fields = row.fields;
        if (fields && typeof fields === "object" && !Array.isArray(fields)) {
          const { __accessUsers: _omit, ...rest } = fields as Record<
            string,
            unknown
          >;
          return { ...row, fields: rest };
        }
        return row;
      },
    },
    {
      name: "entityInstanceTags",
      table: entityInstanceTags,
      keys: ["id", "entityInstanceId", "tagText", "createdBy", "createdAt"],
      userColumns: [{ key: "createdBy" }],
      orderBy: "id",
    },
    {
      name: "workflows",
      table: workflows,
      keys: [
        "id",
        "entityTypeId",
        "name",
        "createdBy",
        "assignedTo",
        "createdAt",
      ],
      userColumns: [{ key: "createdBy" }, { key: "assignedTo", array: true }],
      orderBy: "id",
    },
    {
      // Includes comments the subject authored (workflow_events.comment), as-is.
      name: "workflowEvents",
      table: workflowEvents,
      keys: [
        "id",
        "instanceId",
        "workflowId",
        "fromState",
        "toState",
        "actorId",
        "comment",
        "metadata",
        "originMechanism",
        "originPerformerUserId",
        "createdAt",
      ],
      userColumns: [{ key: "actorId" }, { key: "originPerformerUserId" }],
      orderBy: "id",
    },
    {
      name: "attachments",
      table: attachments,
      keys: [
        "id",
        "ticketId",
        "uploadedBy",
        "actingPersonId",
        "declaredFilename",
        "declaredSizeBytes",
        "declaredMimeType",
        "filesId",
        "status",
        "boundAt",
        "createdAt",
      ],
      userColumns: [{ key: "uploadedBy" }, { key: "actingPersonId" }],
      orderBy: "id",
    },
    {
      name: "files",
      table: files,
      keys: [
        "id",
        "moduleSlug",
        "entityId",
        "originalName",
        "mimeType",
        "sizeBytes",
        "scanStatus",
        "uploadedBy",
        "createdAt",
      ],
      userColumns: [{ key: "uploadedBy" }],
      orderBy: "id",
    },
    {
      name: "idempotencyKeys",
      table: idempotencyKeys,
      keys: [
        "id",
        "apiKeyId",
        "actingPersonId",
        "idempotencyKey",
        "responseStatus",
        "createdAt",
        "expiresAt",
      ],
      userColumns: [{ key: "actingPersonId" }],
      orderBy: "id",
    },
    {
      name: "connectorCredentials",
      table: connectorCredentials,
      keys: ["id", "connectorId", "createdAt", "disabledAt", "disabledBy"],
      userColumns: [{ key: "disabledBy" }],
      orderBy: "id",
    },
    {
      name: "labels",
      table: labels,
      keys: ["id", "name", "color", "description", "createdBy", "createdAt"],
      userColumns: [{ key: "createdBy" }],
      orderBy: "id",
    },
    {
      name: "ticketLabels",
      table: ticketLabels,
      keys: ["ticketInstanceId", "labelId", "assignedBy", "assignedAt"],
      userColumns: [{ key: "assignedBy" }],
      orderBy: "assignedAt",
    },
    {
      name: "notificationPolicies",
      table: notificationPolicies,
      keys: [
        "id",
        "teamId",
        "workflowTypeId",
        "severity",
        "channels",
        "createdBy",
        "createdAt",
      ],
      userColumns: [{ key: "createdBy" }],
      orderBy: "id",
    },
    {
      name: "teams",
      table: teams,
      keys: ["id", "name", "description", "createdBy", "createdAt"],
      userColumns: [{ key: "createdBy" }],
      orderBy: "id",
    },
    {
      name: "services",
      table: services,
      keys: ["id", "name", "description", "teamId", "createdBy", "createdAt"],
      userColumns: [{ key: "createdBy" }],
      orderBy: "id",
    },
    {
      name: "onCallSchedules",
      table: onCallSchedules,
      keys: [
        "id",
        "teamId",
        "label",
        "startsAt",
        "endsAt",
        "primaryUserId",
        "backupUserId",
        "escalationManagerUserId",
        "createdBy",
        "createdAt",
      ],
      userColumns: [
        { key: "primaryUserId" },
        { key: "backupUserId" },
        { key: "escalationManagerUserId" },
        { key: "createdBy" },
      ],
      orderBy: "id",
    },
    {
      name: "scheduleRules",
      table: scheduleRules,
      keys: [
        "id",
        "name",
        "description",
        "cronExpr",
        "timezone",
        "entityTypeId",
        "workflowId",
        "template",
        "status",
        "createdBy",
        "createdAt",
      ],
      userColumns: [{ key: "createdBy" }],
      orderBy: "id",
    },
    {
      name: "orgEmployees",
      table: orgEmployees,
      keys: [
        "id",
        "userId",
        "parentId",
        "name",
        "title",
        "department",
        "email",
        "isRoot",
        "createdAt",
      ],
      userColumns: [{ key: "userId" }],
      orderBy: "id",
    },
    {
      name: "orgDirectorySyncRuns",
      table: orgDirectorySyncRuns,
      keys: [
        "id",
        "status",
        "startedAt",
        "completedAt",
        "employeeCount",
        "triggeredBy",
        "createdAt",
      ],
      userColumns: [{ key: "triggeredBy" }],
      orderBy: "id",
    },
  ];
}

function buildAuditSection(): SectionSpec {
  return {
    name: "auditLog",
    table: adminAuditLog,
    // Snapshots describe the audited resource, which others may have authored.
    keys: [
      "id",
      "actorId",
      "actorType",
      "actingPersonId",
      "resourceType",
      "resourceId",
      "action",
      "metadata",
      "createdAt",
    ],
    userColumns: [{ key: "actorId" }, { key: "actingPersonId" }],
    orderBy: "id",
  };
}

function columnsOf(spec: SectionSpec): Record<string, PgColumn> {
  return getTableColumns(spec.table) as Record<string, PgColumn>;
}

function refOf(spec: SectionSpec, col: UserColumnSpec): string {
  const column = columnsOf(spec)[col.key];
  if (!column) {
    throw new Error(`user-data export: ${spec.name} has no column ${col.key}`);
  }
  return `${getTableName(spec.table)}.${column.name}`;
}

/** Every `table.column` reference the collector reads, derived from the sections. */
export function userDataExportCollectedColumns(): string[] {
  const { sections, audit } = getSections();
  return [...sections, audit].flatMap((s) =>
    s.userColumns.map((c) => refOf(s, c)),
  );
}

/**
 * User-reference columns the bundle deliberately omits, with the reason. The
 * coverage guard requires every column in the erasure inventory to be here or
 * in userDataExportCollectedColumns.
 */
export const USER_DATA_EXPORT_EXCLUDED_COLUMNS: Readonly<
  Record<string, string>
> = {
  "ticket_alerts.recipients_snapshot":
    "recipient list on an alert authored by someone else; the alert is that author's record (alerts the subject created are collected via ticket_alerts.created_by)",
  "workflow_events.triggered_by":
    "not a user reference: holds the trigger type ('user', 'automation', 'api', 'system'); the author is workflow_events.actor_id",
  "sandbox_provisioning_jobs.requested_by":
    "platform_admin who requested provisioning, not a tenant member; the table is platform-level and holds no tenant data",
};

/** Columns named in each section's allow-list; used by tests to check redaction. */
export function userDataExportSectionColumns(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const { sections, audit } = getSections();
  for (const s of [...sections, audit]) {
    out[s.name] = s.keys.map((k) => columnsOf(s)[k]?.name ?? `?${k}`);
  }
  return out;
}

function projectionOf(spec: SectionSpec): Record<string, PgColumn> {
  const all = columnsOf(spec);
  const out: Record<string, PgColumn> = {};
  for (const key of spec.keys) {
    const col = all[key];
    if (!col) {
      throw new Error(`user-data export: ${spec.name} has no column ${key}`);
    }
    out[key] = col;
  }
  return out;
}

async function selectSection(
  tx: DbOrTx,
  spec: SectionSpec,
  tenantId: string,
  userId: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const all = columnsOf(spec);
  const tenantCol = all.tenantId;
  const orderCol = all[spec.orderBy];
  if (!tenantCol || !orderCol) {
    throw new Error(`user-data export: ${spec.name} lacks tenantId/order`);
  }
  const matches = spec.userColumns.map((u) => {
    const col = all[u.key];
    if (!col) throw new Error(`user-data export: ${spec.name} lacks ${u.key}`);
    return u.array ? sql`${userId} = ANY(${col})` : eq(col, userId);
  });
  const run = (q: DbOrTx): Promise<Record<string, unknown>[]> =>
    q
      .select(projectionOf(spec))
      .from(spec.table)
      .where(and(eq(tenantCol, tenantId), or(...matches)))
      .orderBy(asc(orderCol))
      .limit(limit + 1);

  if (!spec.userScopedRls) return run(tx);

  // Same technique as eraseUserFromTenant: the caller is an admin, so the
  // app.user_id GUC is switched to the subject for this one read inside a
  // savepoint, which also restores it if the read throws.
  return tx.transaction(async (sp) => {
    const [setting] = await sp.execute<{ current: string | null }>(
      sql`SELECT current_setting('app.user_id', true) AS current`,
    );
    await sp.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
    const rows = await run(sp);
    await sp.execute(
      sql`SELECT set_config('app.user_id', ${setting?.current ?? null}, true)`,
    );
    return rows;
  });
}

export type CollectUserDataOptions = {
  tenantId: string;
  userId: string;
  rowLimit: number;
  includeAudit: boolean;
  ttlDays?: number;
  now?: Date;
};

export async function collectUserDataBundle(
  tx: DbOrTx,
  opts: CollectUserDataOptions,
): Promise<UserDataBundle> {
  const { tenantId, userId, rowLimit, includeAudit } = opts;
  const now = opts.now ?? new Date();
  const truncated: string[] = [];
  const data: Record<string, UserDataExportSectionRows> = {};

  const { sections, audit } = getSections();
  const specs = includeAudit ? [...sections, audit] : [...sections];
  for (const spec of specs) {
    let rows = await selectSection(tx, spec, tenantId, userId, rowLimit);
    if (rows.length > rowLimit) {
      truncated.push(spec.name);
      rows = rows.slice(0, rowLimit);
    }
    data[spec.name] = spec.transform ? rows.map(spec.transform) : rows;
  }

  // The notification content behind the subject's recipient rows.
  const notificationIds = (data.notificationRecipients ?? []).map((r) =>
    String(r.notificationId),
  );
  data.notifications =
    notificationIds.length === 0
      ? []
      : await tx
          .select({
            id: notifications.id,
            type: notifications.type,
            title: notifications.title,
            body: notifications.body,
            link: notifications.link,
            channel: notifications.channel,
            createdAt: notifications.createdAt,
          })
          .from(notifications)
          .where(
            and(
              eq(notifications.tenantId, tenantId),
              inArray(notifications.id, notificationIds),
            ),
          )
          .orderBy(asc(notifications.id));

  return {
    metadata: {
      schemaVersion: 1,
      tenantId,
      subjectUserId: userId,
      generatedAt: now.toISOString(),
      availableUntil:
        opts.ttlDays === undefined
          ? null
          : new Date(now.getTime() + opts.ttlDays * 86_400_000).toISOString(),
      rowLimit,
      includeAudit,
      truncated,
      exclusions: {
        ...BUNDLE_EXCLUSIONS,
        ...(includeAudit
          ? {}
          : { auditLog: "disabled by USER_EXPORT_INCLUDE_AUDIT=false" }),
      },
    },
    data,
  };
}

/** JSON.stringify with bigint columns (declared_size_bytes) as strings. */
export function serializeUserDataBundle(bundle: UserDataBundle): Buffer {
  return Buffer.from(
    JSON.stringify(
      bundle,
      (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
    "utf-8",
  );
}
