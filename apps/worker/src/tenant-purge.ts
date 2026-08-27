/**
 * Tenant purge worker — hard-deletes all data for a tenant scheduled for deletion.
 *
 * Triggered by a delayed BullMQ job (default 30-day delay) enqueued by
 * `scheduleTenantDeletion` in the API's tenant lifecycle service.
 *
 * FK-safe deletion order (children before parents):
 *   files (DB rows) → workflowTransitions → workflowStates → workflowEvents
 *   → workflows → entityRelations → entityInstances → entityFields → entityTypes
 *   → automationExecutions → automationRules → deadLetterEvents → outboxEvents
 *   → connectorDeliveryAttempts → connectorCredentials → apiKeys → tenantUsers
 *   → viewConfigs → pluginErrors → installedPlugins → idempotencyKeys
 *   [admin_audit_log rows anonymized in place, not deleted -- spec R9]
 *   → tenant.status = 'purged'
 *   then on-disk files purged (best-effort, outside DB transaction)
 *
 * Plugin data (3B, docs/specs/plugin-system.md R13): plugin-authored tables live
 * in per-plugin Postgres schemas (plugin_<slug>), not in this file's own FK
 * graph — a plugin's schema is shared by every tenant with that plugin
 * installed, so deleting a tenant must delete only that tenant's rows within
 * each installed plugin's schema, never drop the schema itself. This runs via
 * purgeTenantDataFromPluginSchema's own raw connection (same
 * "compensating design" as runPluginMigration — it does not share this
 * function's withTenantContext transaction), BEFORE the platform-tracked
 * installedPlugins/pluginErrors rows are deleted below, since those rows are
 * what list which plugin schemas to purge in the first place.
 *
 * Each DB step uses `withTenantContext` so RLS policies pass for the target tenant.
 * `tenants` has no RLS and uses plain `db`. `admin_audit_log` has RLS (migration 0011)
 * granting app_user INSERT+SELECT only (append-only invariant) -- anonymization uses
 * plain `db` (the worker's privileged connection) because an UPDATE cannot go through
 * app_user; the RLS policy itself never needs to block this write since only the
 * privileged worker role ever updates these rows.
 * `workflow_states`/`workflow_transitions` gained RLS and a `tenant_id` column in
 * ADR-007 (migration 0037) — their deletes below now filter by `tenant_id` directly
 * (in addition to the pre-existing `inArray(workflowId, wfIds)` filter), matching every
 * other table in this function.
 *
 * The job is idempotent: re-running after partial failure is safe because
 * each DELETE targets by tenant_id and missing rows are a no-op.
 */

import { Worker } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  withTenantContext,
  purgeTenantDataFromPluginSchema,
} from "@platform/db";
import {
  tenants,
  files,
  viewConfigs,
  apiKeys,
  tenantUsers,
  connectorCredentials,
  installedPlugins,
  pluginErrors,
  pluginDefinitions,
} from "@platform/db";
import { logger } from "@platform/logger";
import { writeAuditEntry, anonymizeAuditLogForTenant } from "@platform/audit";
import { deleteTenantFiles } from "@platform/files";
import { connection } from "./queues.js";

import {
  entityInstances,
  entityRelations,
  entityFields,
  entityTypes,
  workflows,
  workflowStates,
  workflowTransitions,
  workflowEvents,
  automationRules,
  automationExecutions,
  outboxEvents,
  deadLetterEvents,
  connectorDeliveryAttempts,
  idempotencyKeys,
} from "@platform/db";

const QUEUE_NAME = "tenant-purge";

type PurgeJobData = { tenantId: string };

export const tenantPurgeWorker = new Worker<PurgeJobData>(
  QUEUE_NAME,
  async (job) => {
    const { tenantId } = job.data;
    logger.info({ tenantId, jobId: job.id }, "tenant-purge: starting");

    // Verify tenant is still in 'deleted' state (idempotency guard)
    const [tenant] = await db
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant) {
      logger.warn(
        { tenantId },
        "tenant-purge: tenant row not found — already purged",
      );
      return;
    }
    if (tenant.status !== "deleted") {
      logger.warn(
        { tenantId, status: tenant.status },
        "tenant-purge: tenant status is not 'deleted' — skipping",
      );
      return;
    }

    // R13: purge this tenant's rows from every installed plugin's schema
    // BEFORE deleting the installedPlugins rows that list which schemas to
    // look at. Uses purgeTenantDataFromPluginSchema's own raw connection —
    // does not share this function's withTenantContext transaction below.
    const installedPluginSlugs = await withTenantContext(tenantId, (tx) =>
      tx
        .select({ slug: pluginDefinitions.slug })
        .from(installedPlugins)
        .innerJoin(
          pluginDefinitions,
          eq(installedPlugins.pluginId, pluginDefinitions.id),
        )
        .where(eq(installedPlugins.tenantId, tenantId)),
    );

    for (const { slug } of installedPluginSlugs) {
      const { tablesPurged } = await purgeTenantDataFromPluginSchema(
        tenantId,
        slug,
      );
      logger.info(
        { tenantId, pluginSlug: slug, tablesPurged },
        "tenant-purge: plugin schema data purged",
      );
    }

    await withTenantContext(tenantId, async (tx) => {
      // M3: DELETE file rows (not just mark deleted) — on-disk bytes are
      // purged after commit via a recursive tenant-directory removal
      await tx.delete(files).where(eq(files.tenantId, tenantId));
      logger.info({ tenantId }, "tenant-purge: file rows deleted");

      // M1: workflow transitions + states, scoped by both workflow ID and tenant_id
      // (the latter added in ADR-007 — kept alongside the workflow ID list rather
      // than replacing it, since a workflow's own delete below is also scoped by
      // workflow_id via FK, not tenant_id directly).
      const tenantWorkflowIds = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(eq(workflows.tenantId, tenantId));

      if (tenantWorkflowIds.length > 0) {
        const wfIds = tenantWorkflowIds.map((r) => r.id);
        await tx
          .delete(workflowTransitions)
          .where(
            and(
              inArray(workflowTransitions.workflowId, wfIds),
              eq(workflowTransitions.tenantId, tenantId),
            ),
          );
        await tx
          .delete(workflowStates)
          .where(
            and(
              inArray(workflowStates.workflowId, wfIds),
              eq(workflowStates.tenantId, tenantId),
            ),
          );
      }

      // Workflow events (has tenant_id, FK → entityInstances + workflows)
      await tx
        .delete(workflowEvents)
        .where(eq(workflowEvents.tenantId, tenantId));

      // Workflow definitions (FK → entity_types; must come before entityTypes)
      await tx.delete(workflows).where(eq(workflows.tenantId, tenantId));

      logger.info({ tenantId }, "tenant-purge: workflow data deleted");

      // Entity relations (FK child of entityInstances)
      await tx
        .delete(entityRelations)
        .where(eq(entityRelations.tenantId, tenantId));

      // Entity instances
      await tx
        .delete(entityInstances)
        .where(eq(entityInstances.tenantId, tenantId));
      logger.info({ tenantId }, "tenant-purge: entity instances deleted");

      // Entity fields + types
      await tx.delete(entityFields).where(eq(entityFields.tenantId, tenantId));
      await tx.delete(entityTypes).where(eq(entityTypes.tenantId, tenantId));

      // Automation
      await tx
        .delete(automationExecutions)
        .where(eq(automationExecutions.tenantId, tenantId));
      await tx
        .delete(automationRules)
        .where(eq(automationRules.tenantId, tenantId));
      logger.info({ tenantId }, "tenant-purge: automation data deleted");

      // Outbox + dead-letter queue
      await tx
        .delete(deadLetterEvents)
        .where(eq(deadLetterEvents.tenantId, tenantId));
      await tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, tenantId));

      // Connector delivery attempts (issue #365) + credentials + API keys
      await tx
        .delete(connectorDeliveryAttempts)
        .where(eq(connectorDeliveryAttempts.tenantId, tenantId));
      await tx
        .delete(connectorCredentials)
        .where(eq(connectorCredentials.tenantId, tenantId));
      await tx.delete(apiKeys).where(eq(apiKeys.tenantId, tenantId));

      // Users + view config
      await tx.delete(tenantUsers).where(eq(tenantUsers.tenantId, tenantId));
      await tx.delete(viewConfigs).where(eq(viewConfigs.tenantId, tenantId));

      // Plugin tracking rows (R13) — the actual plugin-schema data was already
      // purged above, before this transaction started.
      await tx.delete(pluginErrors).where(eq(pluginErrors.tenantId, tenantId));
      await tx
        .delete(installedPlugins)
        .where(eq(installedPlugins.tenantId, tenantId));

      // ADR-012 Phase G, spec R10 -- idempotency_keys.response_body can
      // contain full ticket/comment content (PII), not just metadata, so
      // unlike admin_audit_log below, there's no operational-history reason
      // to keep a placeholder row here: deleted outright, not anonymized.
      await tx
        .delete(idempotencyKeys)
        .where(eq(idempotencyKeys.tenantId, tenantId));
    });

    // ADR-012 Phase G, spec R9 -- admin_audit_log rows are anonymized in
    // place (person-identifying fields replaced with a placeholder), never
    // deleted: aggregate operational history (action/resourceType/outcome/
    // timestamp) must survive a purge the same way it survives the R8 age-
    // based sweep. Runs via plain `db` (not withTenantContext), same as
    // every other admin_audit_log write in this file -- see
    // anonymizeAuditLogForTenant's own doc comment for why.
    await anonymizeAuditLogForTenant(db, tenantId);

    // Mark the tenant row as 'purged' (keeps a tombstone for audit trail).
    await db
      .update(tenants)
      .set({ status: "purged", updatedAt: new Date() })
      .where(and(eq(tenants.id, tenantId), eq(tenants.status, "deleted")));

    // G5: write purge completion to the audit log
    await writeAuditEntry(db, {
      tenantId,
      actorId: "system",
      actorType: "system",
      resourceType: "tenant",
      resourceId: tenantId,
      action: "purge.completed",
      afterSnapshot: { status: "purged" },
      metadata: { jobId: job.id, attemptsMade: job.attemptsMade },
    });

    logger.info(
      { tenantId },
      "tenant-purge: DB purge complete — tenant marked purged",
    );

    // M3: delete on-disk files after DB transaction commits (best-effort)
    await deleteTenantFiles(tenantId);

    logger.info({ tenantId }, "tenant-purge: complete");
  },
  {
    connection,
    concurrency: 1, // one purge at a time to avoid DB contention
  },
);

tenantPurgeWorker.on("failed", (job, err) => {
  if (!job) return;
  const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
  logger.error(
    {
      jobId: job.id,
      tenantId: job.data.tenantId,
      err: String(err),
      attemptsMade: job.attemptsMade,
      isFinalAttempt,
    },
    "tenant-purge: job failed",
  );

  // G5: write purge failure to the audit log on the final attempt only
  if (isFinalAttempt) {
    void writeAuditEntry(db, {
      tenantId: job.data.tenantId,
      actorId: "system",
      actorType: "system",
      resourceType: "tenant",
      resourceId: job.data.tenantId,
      action: "purge.failed",
      metadata: {
        err: String(err),
        jobId: job.id,
        attemptsMade: job.attemptsMade,
      },
    }).catch((auditErr: unknown) => {
      logger.error(
        { tenantId: job.data.tenantId, err: String(auditErr) },
        "tenant-purge: failed to write failure audit entry",
      );
    });
  }
});

export async function stopTenantPurgeWorker(): Promise<void> {
  await tenantPurgeWorker.close();
}
