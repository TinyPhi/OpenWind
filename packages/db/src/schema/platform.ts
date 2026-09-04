import {
  pgTable,
  uuid,
  text,
  jsonb,
  bigint,
  timestamp,
  date,
  index,
  unique,
  uniqueIndex,
  boolean,
  integer,
  primaryKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: text("plan").default("standard").notNull(),
  // Maps this tenant to a Zitadel org (see docs/specs/tenant-org-id-mapping.md).
  // Nullable — demo/dev tenants may have no real org yet.
  zitadelOrgId: text("zitadel_org_id").unique(),
  // Lifecycle: provisioning → active → suspended → deleted → purged
  // text + CHECK (see migration 0001) so new states don't require ALTER TYPE
  status: text("status").default("active").notNull(),
  config: jsonb("config").default({}).notNull(),
  /** Set when status → suspended; cleared on reactivation. */
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  /** When the GDPR purge job runs (default 30 days after deletion request). */
  deletionScheduledAt: timestamp("deletion_scheduled_at", {
    withTimezone: true,
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const modules = pgTable("modules", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  version: text("version").notNull(),
  isSystem: boolean("is_system").default(false).notNull(),
  minPlan: text("min_plan").default("standard").notNull(),
  // Global, platform-wide toggle — controls whether this template appears in
  // every tenant's Templates page. Admin-only (the platform's top role — no
  // separate superadmin tier); not per-tenant. Defaults to true so existing
  // behavior (every seeded module visible) is unchanged.
  isVisible: boolean("is_visible").default(true).notNull(),
  // ADR-005: 'core' modules auto-install on tenant provisioning
  // (tenant-lifecycle.ts's provisionTenant); 'optional' modules require a
  // manual install via the Templates page. Enforced at the DB layer by a
  // CHECK constraint (migration 0051) — Drizzle's text() type doesn't model
  // the enum, so keep this in sync with that CHECK if values ever change.
  category: text("category").default("optional").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    keyHashArgon2: text("key_hash_argon2"),
    scopes: text("scopes").array().default([]).notNull(),
    /** Discriminates scopes' string shape (ADR-008 Decision #6) — 'role' (legacy, unchanged) or 'action' (entity:<entityType>:<verb>, ADR-010 Tier-1 prerequisite). Existing and new keys default 'role'; see 0055_api_keys_scopes_format.sql. The `enum` option only narrows the TS type — the DB CHECK constraint (migration 0055) remains the actual runtime enforcement. */
    scopesFormat: text("scopes_format", { enum: ["role", "action"] })
      .default("role")
      .notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Zitadel user id of whoever minted this key (ADR-008 Decision #2). Nullable — NULL for keys created before migration 0053. */
    createdBy: text("created_by"),
    /** Nullable — NULL means immortal (legacy keys; ADR-008 Decision #3). */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Soft-revoke marker (ADR-008 Decision #4) — resolve_api_key_by_hash excludes non-NULL rows. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    /** Set on the replacement key minted by POST /api-keys/:id/rotate; points at the key it replaced. */
    rotatedFrom: uuid("rotated_from").references((): AnyPgColumn => apiKeys.id),
    /** Third-party application record (ADR-012 Phase A). NULL for keys not minted through the third-party key-management flow. */
    applicationName: text("application_name"),
    applicationDescription: text("application_description"),
    /** Unblocks a deferred expiry-notification fast-follow (ADR-012 Decision #10). */
    applicationContactEmail: text("application_contact_email"),
    /** Makes Phase B's `aud` audience check correct (ADR-012 Decision #1). Unique across (revoked_at IS NULL AND oidc_client_id_active) keys — see migration 0068/0069/0072's partial index; expired-but-not-revoked reuse is an application-layer check, not a DB constraint. CHECK constraint (migration 0075): char_length ≤ 200; Drizzle's text() type doesn't model this, so keep this comment in sync with that CHECK if it ever changes. */
    oidcClientId: text("oidc_client_id"),
    /** Migration 0069/0072 — separates "still authenticating" (revoked_at) from "currently holds this Client ID for uniqueness purposes." Rotation needs both the dying predecessor and the new successor to authenticate/carry the same oidc_client_id value during the 24h grace window, but only one of them should count toward uniqueness — rotate.ts flips this false on the predecessor in the same transaction that inserts the successor (which keeps the column default, true). Every other code path leaves this untouched. */
    oidcClientIdActive: boolean("oidc_client_id_active")
      .default(true)
      .notNull(),
    /** docs/specs/third-party-key-external-org-mapping.md — set together, only when this key's acting-person tokens come from a DIFFERENT IdP than the tenant's primary (tenants.zitadel_org_id). NULL/NULL (the default) means "use the tenant's primary mapping," today's unchanged behavior. Enforced together (and only required when actually needed) at the API layer (create.ts), not here — same pattern as applicationName/oidcClientId above. */
    externalIssuer: text("external_issuer"),
    externalOrgId: text("external_org_id"),
    /** Migration 0087/0088 — admin-UI API Keys card view groups keys into one card per (tenant-scoped, normalized) applicationName; enforced as a real DB uniqueness constraint, same rationale as oidcClientId's global one. Same active-claim-holder pattern as oidcClientIdActive above and for the same reason: rotate.ts keeps a rotated key's predecessor row active (revoked_at untouched) for its 24h grace window while inserting a successor under the SAME applicationName — rotate.ts flips this false on the predecessor in the same update that flips oidcClientIdActive false. */
    applicationNameActive: boolean("application_name_active")
      .default(true)
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("api_keys_tenant_idx").on(t.tenantId),
    // Migration 0068/0069/0072 — active (non-revoked, oidc_client_id_active)
    // keys only; see those migrations' comments for why expired-but-not-
    // revoked reuse can't also live in this predicate (partial-index
    // predicates must be immutable, `now()` isn't), and why the separate
    // oidc_client_id_active flag exists (rotation's grace-window handoff).
    oidcClientIdActiveUnique: uniqueIndex(
      "api_keys_oidc_client_id_active_unique",
    )
      .on(t.oidcClientId)
      .where(
        sql`${t.revokedAt} IS NULL AND ${t.oidcClientIdActive} = true AND ${t.oidcClientId} IS NOT NULL`,
      ),
    // Migration 0087/0088 — same active-claim-holder shape as the Client ID
    // index above, keyed by (tenant, normalized name) instead of a global
    // Client ID, since applicationName is a per-tenant human label, not a
    // platform-wide external identity.
    applicationNameActiveUnique: uniqueIndex(
      "api_keys_tenant_application_name_active_unique",
    )
      .on(t.tenantId, sql`lower(btrim(${t.applicationName}))`)
      .where(
        sql`${t.revokedAt} IS NULL AND ${t.applicationNameActive} = true AND ${t.applicationName} IS NOT NULL`,
      ),
  }),
);

/**
 * tenant_users — shadow table that records every user who has successfully
 * authenticated into a tenant.  Populated by a fire-and-forget upsert in the
 * requireAuth JWT path; used by the entity engine to validate user_ref fields
 * cross-tenant (a user_ref UUID must resolve to a user in the same tenant).
 *
 * RLS: enforced via app.tenant_id GUC, consistent with other tenant tables.
 * The auth middleware upsert runs inside withTenantContext so the GUC is set.
 */
export const tenantUsers = pgTable(
  "tenant_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    /** External user ID — Zitadel JWT sub claim value */
    userId: text("user_id").notNull(),
    /** Email from JWT — updated on each login */
    email: text("email"),
    /** Display name from JWT name/given_name claim — updated on each login */
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    // No explicit index needed — the uniqueTenantUser unique constraint below
    // automatically creates a backing B-tree index on (tenant_id, user_id),
    // which serves as the primary lookup pattern.
    uniqueTenantUser: unique("tenant_users_tenant_user_unique").on(
      t.tenantId,
      t.userId,
    ),
  }),
);

/**
 * files — tenant-scoped file metadata with AV scan status tracking.
 * Actual file bytes live in S3; this table tracks the lifecycle.
 * RLS: enforced via app.tenant_id GUC.
 */
export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    moduleSlug: text("module_slug").notNull(),
    entityId: uuid("entity_id"),
    originalName: text("original_name").notNull(),
    /** S3 path: {tenantId}/{moduleSlug}/{entityId}/{uuid}-{filename} */
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    /** pending | clean | quarantined | scan_failed | deleted */
    scanStatus: text("scan_status").default("pending").notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantScanIdx: index("files_tenant_scan_idx").on(t.tenantId, t.scanStatus),
    tenantEntityIdx: index("files_tenant_entity_idx").on(
      t.tenantId,
      t.entityId,
    ),
    entityCleanScanIdx: index("files_entity_clean_scan_idx")
      .on(t.tenantId, t.entityId, t.scanStatus)
      .where(sql`scan_status = 'clean'`),
  }),
);

/**
 * attachments — ADR-012 Phase D, third-party API file attachment lifecycle
 * (presign -> upload -> ticket binding), ahead of the actual bytes landing
 * in `files` (filesId nullable until upload completes).
 * RLS: enforced via app.tenant_id GUC.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    ticketId: uuid("ticket_id"),
    boundAt: timestamp("bound_at", { withTimezone: true }),
    uploadedBy: text("uploaded_by").notNull(),
    actingPersonId: text("acting_person_id").notNull(),
    declaredFilename: text("declared_filename").notNull(),
    declaredSizeBytes: bigint("declared_size_bytes", {
      mode: "number",
    }).notNull(),
    declaredMimeType: text("declared_mime_type").notNull(),
    uploadTokenHash: text("upload_token_hash").notNull(),
    uploadExpiresAt: timestamp("upload_expires_at", {
      withTimezone: true,
    }).notNull(),
    filesId: uuid("files_id"),
    /** pending | uploaded | expired */
    status: text("status").default("pending").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    // Partial predicates below must match migration 0077_attachments.sql's
    // actual CREATE INDEX statements exactly -- Drizzle doesn't introspect
    // partial indexes from SQL migrations, so a mismatch here would make the
    // next `drizzle-kit generate` emit a spurious drop/recreate migration.
    tenantTicketIdx: index("attachments_tenant_ticket_idx")
      .on(t.tenantId, t.ticketId)
      .where(sql`${t.ticketId} IS NOT NULL`),
    tenantStatusIdx: index("attachments_tenant_status_idx").on(
      t.tenantId,
      t.status,
    ),
    expiryIdx: index("attachments_expiry_idx")
      .on(t.uploadExpiresAt)
      .where(sql`${t.status} IN ('pending', 'uploading')`),
  }),
);

/**
 * idempotencyKeys — ADR-012 Phase G, spec R3/R4/R5/R10. Caches a third-party
 * request's result for 24h, scoped to the (tenantId, apiKeyId,
 * actingPersonId, idempotencyKey) 4-way key. Never updated after insert —
 * a same-key-different-content retry is rejected at the application layer
 * (R4) rather than overwriting this row. RLS: enforced via app.tenant_id GUC.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    apiKeyId: uuid("api_key_id").notNull(),
    actingPersonId: text("acting_person_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    contentHash: text("content_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    scopeUnique: unique("idempotency_keys_scope_unique").on(
      t.tenantId,
      t.apiKeyId,
      t.actingPersonId,
      t.idempotencyKey,
    ),
    expiresIdx: index("idempotency_keys_expires_idx").on(t.expiresAt),
  }),
);

/**
 * adminAuditLog — append-only audit log for all entity mutations.
 * GRANT: INSERT + SELECT only for app_user; no UPDATE or DELETE.
 * RLS: USING only policy (app_user cannot read rows outside their tenant).
 */
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    actorId: text("actor_id").notNull(),
    /** user | api_key | system */
    actorType: text("actor_type").notNull(),
    /** ADR-012 Phase B, spec R9/GAP-05 — the real person acting through a third-party API key, distinct from actorId (the key itself). NULL for every non-third-party actor. */
    actingPersonId: text("acting_person_id"),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    /** created | updated | deleted | transitioned | restored */
    action: text("action").notNull(),
    /** null for create actions; PII-redacted */
    beforeSnapshot: jsonb("before_snapshot"),
    /** null for delete actions; PII-redacted */
    afterSnapshot: jsonb("after_snapshot"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantResourceIdx: index("audit_log_tenant_resource_idx").on(
      t.tenantId,
      t.resourceType,
      t.resourceId,
    ),
    tenantActorIdx: index("audit_log_tenant_actor_idx").on(
      t.tenantId,
      t.actorId,
    ),
    tenantCreatedIdx: index("audit_log_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
    createdAtIdx: index("admin_audit_log_created_at_idx").on(t.createdAt),
  }),
);

/**
 * adminAuditLogDailyRollup — ADR-012 Phase G, spec R8. Aggregate counts
 * (per tenant/day/resourceType/action) that survive the 90-day
 * admin_audit_log detail-row sweep (apps/worker/src/access-log-retention.ts).
 * "outcome" is deliberately not stored -- derived from `action` at query
 * time via @platform/audit's classifyOutcome. RLS: enforced via
 * app.tenant_id GUC (migration 0083) -- the worker's own writes use the
 * privileged connection and bypass it, same as adminAuditLog's writes.
 */
export const adminAuditLogDailyRollup = pgTable(
  "admin_audit_log_daily_rollup",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    resourceType: text("resource_type").notNull(),
    action: text("action").notNull(),
    count: bigint("count", { mode: "number" }).default(0).notNull(),
  },
  (t) => ({
    scopeUnique: unique("admin_audit_log_daily_rollup_scope_unique").on(
      t.tenantId,
      t.day,
      t.resourceType,
      t.action,
    ),
    tenantDayIdx: index("admin_audit_log_daily_rollup_tenant_day_idx").on(
      t.tenantId,
      t.day,
    ),
  }),
);

/**
 * platformSettings — single-row global platform config (see
 * 0044_platform_settings.sql). No tenant_id/RLS, deliberately: this is a
 * platform-operator concern (like modules.isVisible), not per-tenant.
 * Always read/write id=1; the DB-level CHECK enforces there's only one row.
 */
export const platformSettings = pgTable("platform_settings", {
  id: integer("id").primaryKey().default(1),
  /**
   * Kill switch for the notification outbound handoff (email/SMS/WhatsApp
   * via the external delivery service, currently unreliable/not live). When
   * false, notify.ts and notification-worker.ts skip enqueueing new
   * notify-outbound jobs; in-app delivery is unaffected either way.
   */
  outboundNotificationsEnabled: boolean("outbound_notifications_enabled")
    .default(true)
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedBy: text("updated_by"),
});

/**
 * connectorDefinitions — platform-wide connector catalog (ADR-009 Decision #8,
 * ADR-001's "Non-tenant-scoped tables" section names this table explicitly).
 * No tenant_id/RLS — readable by app_user, writable only by migration_user/
 * admin-role endpoints, same restriction as `modules`.
 *
 * Declarative catalog metadata only (see 0056_connector_definitions.sql) —
 * `triggers`/`actions` (packages/connector-sdk's TriggerDefinition[]/
 * ActionDefinition[]) carry functions, not serializable data, and are never
 * columns here. `allowedHosts` is a display/audit snapshot only; the actual
 * egress enforcement is packages/connector-sdk/src/runtime.ts's callApi().
 */
export const connectorDefinitions = pgTable("connector_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  description: text("description"),
  iconUrl: text("icon_url"),
  docsUrl: text("docs_url"),
  /** communication | finance | crm | hr | storage | ecommerce | other — enforced by a DB CHECK (migration 0056), matching modules.category's pattern. */
  category: text("category").notNull(),
  allowedHosts: text("allowed_hosts").array().notNull(),
  isVisible: boolean("is_visible").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * connectorCredentials — tenant-scoped connector installation row (ADR-009
 * Decision #8, issue #363). Predates the ADR — scaffolded as a placeholder
 * in the very first migration (0000_initial_schema.sql) with a shape that
 * never matched any real consumer; reshaped in place by migration 0056 to
 * back packages/connector-sdk's ConnectorContext/ConnectorAuthConfig
 * (packages/connector-sdk/src/types.ts) rather than creating a second,
 * differently-named table.
 *
 * `secrets` is a JSONB map of credentialKey -> vault/encryption provider ciphertext, matching
 * runtime.ts's `encryptedCredentials: Record<string, string>` parameter
 * exactly — actual plaintext credentials are never stored here.
 * `cursor_state` is 1:1 polling-cursor state for polling connectors
 * (ADR-009 Decision #7), nullable.
 * `disabled_at`/`disabled_by` (migration 0063, issue #367) are the kill
 * switch — non-destructive, NULL means enabled. Every column above is
 * untouched by a disable/enable toggle.
 *
 * RLS (tenant_read/tenant_write, migration 0001) and the app_user grant
 * (SELECT/INSERT/UPDATE/DELETE, migration 0019) are unchanged by migration
 * 0056 — apps/worker/src/tenant-purge.ts's tenant-scoped delete depends on
 * the existing DELETE grant and needed no code change.
 */
export const connectorCredentials = pgTable(
  "connector_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => connectorDefinitions.id),
    /** credentialKey -> vault/encryption provider ciphertext (see ConnectorAuthConfig). Never plaintext. */
    secrets: jsonb("secrets").default({}).notNull(),
    /** Polling-connector cursor (e.g. last-seen IMAP UID) — 1:1 with this installation row. */
    cursorState: jsonb("cursor_state"),
    /** Kill switch (issue #367) — soft, non-destructive disable, NULL means enabled. Mirrors api_keys.revoked_at's shape. Checked by the inbound webhook gateway, outbound delivery worker, and polling scheduler/worker before processing. */
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    /** Actor (Zitadel user id) who last flipped disabledAt, if any. */
    disabledBy: text("disabled_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("connector_credentials_tenant_idx").on(
      t.tenantId,
      t.connectorId,
    ),
    tenantConnectorUnique: unique(
      "connector_credentials_tenant_connector_unique",
    ).on(t.tenantId, t.connectorId),
  }),
);

/**
 * connectorDeliveryAttempts — one row per connector outbound delivery attempt
 * (ADR-009 Decision #9, issue #365). Tenant-scoped, RLS-protected (migration
 * 0057). Without this, a dead-lettered connector delivery simply disappears
 * (`dead_letter_events` has zero readers in apps/api or apps/admin-ui today) —
 * this table is the per-attempt log leading up to that terminal case, not a
 * replacement for it. A redrive UI/API over these rows is deliberately out of
 * scope for issue #365.
 *
 * `connectorId` is nullable + ON DELETE SET NULL (matches
 * dead_letter_events.original_event_id's pattern) — the attempt record must
 * outlive the catalog row if the connector is later removed.
 *
 * `deliveryId` is the idempotency identifier sent as the outbound request's
 * X-OpenWind-Delivery-Id header (mirrors svix-id) — stable across every retry
 * of the same logical delivery, so multiple rows here can share one value
 * (one row per attemptNumber).
 */
export const connectorDeliveryAttempts = pgTable(
  "connector_delivery_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    connectorId: uuid("connector_id").references(() => connectorDefinitions.id),
    deliveryId: uuid("delivery_id").notNull(),
    /** pending | success | failed | exhausted — enforced by a DB CHECK (migration 0057). */
    status: text("status", {
      enum: ["pending", "success", "failed", "exhausted"],
    }).notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    /** Set on a 'failed' row that still has BullMQ attempts remaining; NULL on 'success'/'exhausted'. */
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantCreatedIdx: index(
      "connector_delivery_attempts_tenant_created_idx",
    ).on(t.tenantId, t.createdAt),
    deliveryIdIdx: index("connector_delivery_attempts_delivery_id_idx").on(
      t.deliveryId,
    ),
  }),
);

/**
 * pluginDefinitions — platform-wide plugin catalog (3B, docs/specs/plugin-system.md
 * R1). No tenant_id/RLS — same class as connectorDefinitions/modules. `trustTier` is
 * a single-value enum today by design (migration 0059) — widening it later is a
 * deliberate CHECK-constraint change, not a schema redesign, mirroring
 * api_keys.scopes_format's explicit-column precedent (ADR-008 Decision #6).
 * `slug` doubles as a Postgres identifier fragment (see create_plugin_schema in
 * migration 0059) — its format is enforced by a DB CHECK, not just here.
 */
export const pluginDefinitions = pgTable("plugin_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  description: text("description"),
  iconUrl: text("icon_url"),
  docsUrl: text("docs_url"),
  category: text("category").notNull(),
  trustTier: text("trust_tier").default("first_party").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * installedPlugins — tenant-scoped install row (R2). `manifestSnapshot` freezes the
 * exact PluginManifest this tenant installed at install time, so a later
 * pluginDefinitions update doesn't retroactively change what's already running.
 */
export const installedPlugins = pgTable(
  "installed_plugins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => pluginDefinitions.id),
    manifestSnapshot: jsonb("manifest_snapshot").notNull(),
    version: text("version").notNull(),
    /** installing | active | error | disabled — enforced by a DB CHECK (migration 0059). */
    status: text("status", {
      enum: ["installing", "active", "error", "disabled"],
    })
      .default("installing")
      .notNull(),
    errorReason: text("error_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantIdx: index("installed_plugins_tenant_idx").on(t.tenantId),
    tenantPluginUnique: unique("installed_plugins_tenant_plugin_unique").on(
      t.tenantId,
      t.pluginId,
    ),
  }),
);

/**
 * pluginErrors — R8. Any lifecycle failure / governor-limit breach (R5) / runtime
 * exception (R7) writes here instead of crashing the platform process. `pluginId` is
 * nullable + ON DELETE SET NULL, matching connectorDeliveryAttempts' pattern — the
 * error record must outlive the catalog row it references.
 */
export const pluginErrors = pgTable(
  "plugin_errors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    pluginId: uuid("plugin_id").references(() => pluginDefinitions.id),
    /** lifecycle_failure | governor_limit_breach | runtime_exception — DB CHECK (migration 0059). */
    kind: text("kind", {
      enum: ["lifecycle_failure", "governor_limit_breach", "runtime_exception"],
    }).notNull(),
    detail: jsonb("detail").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    tenantCreatedIdx: index("plugin_errors_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
  }),
);

/**
 * tenantUsageDaily — narrow (tenant_id, usage_date, metric) -> value daily aggregation table
 * (ADR-015 Decision #3, issue #505).
 */
export const tenantUsageDaily = pgTable(
  "tenant_usage_daily",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    usageDate: date("usage_date").notNull(),
    metric: text("metric").notNull(), // 'api_calls' | 'storage_bytes' | 'ai_tokens'
    value: bigint("value", { mode: "number" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.usageDate, t.metric] }),
    tenantIdx: index("tenant_usage_daily_tenant_idx").on(t.tenantId),
    tenantDateIdx: index("tenant_usage_daily_tenant_date_idx").on(
      t.tenantId,
      t.usageDate,
    ),
  }),
);
