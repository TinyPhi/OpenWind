/**
 * PATCH /connectors/:connectorId/disabled — connector kill switch (issue
 * #367, ADR-009 Decision #9's "existing kill-switch precedent" note).
 *
 * Scoped to the caller's own tenant (auth.tenantId, never a path param) —
 * same convention as api-keys/rotate.ts. 404s (not 403) when the caller's
 * tenant has no installation for :connectorId, matching security.md's
 * cross-tenant-resource convention.
 *
 * Single atomic UPDATE guarded by the row's CURRENT state (mirrors
 * api-keys/delete.ts's soft-revoke idiom exactly: `WHERE ... AND
 * isNull(revokedAt)` there, `isNull/isNotNull(disabledAt)` here) rather than
 * a separate SELECT-then-UPDATE — a two-statement version has a TOCTOU
 * window where two concurrent PATCH calls can each read the same stale
 * prior state before either commits, corrupting the audit trail's
 * beforeSnapshot (security-review finding). Same as delete.ts, requesting a
 * state the row is already in returns the SAME 404 as "no installation
 * exists" — 0 rows matched either way, and the guard makes "prior state"
 * always the logical opposite of what was just requested, so no separate
 * read is needed to populate the audit beforeSnapshot.
 *
 * Non-destructive: only disabled_at/disabled_by change. secrets and
 * cursor_state are untouched, so re-enabling resumes exactly where things
 * left off. Enforcement of the flag itself lives at each processing path
 * (webhooks/handler.ts, connector-outbound-worker.ts,
 * connector-poll-scheduler.ts/connector-poll-worker.ts) — this route only
 * flips it.
 */
import { z } from "zod";
import { and, isNull, isNotNull } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import {
  withTenantContext,
  connectorCredentials,
  connectorInstallationFilter,
} from "@platform/db";
import { writeAuditEntry } from "@platform/audit";
import { zValidator } from "../../lib/validator.js";
import { factory } from "./factory.js";

const ParamsSchema = z.object({ connectorId: z.string().uuid() });
const BodySchema = z.object({ disabled: z.boolean() });

export const setConnectorDisabledHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("param", ParamsSchema),
  zValidator("json", BodySchema),
  async (c) => {
    const { connectorId } = c.req.valid("param");
    const { disabled } = c.req.valid("json");
    const { tenantId, userId } = c.get("auth");

    const updated = await withTenantContext(tenantId, async (tx) => {
      const [row] = await tx
        .update(connectorCredentials)
        .set({
          disabledAt: disabled ? new Date() : null,
          disabledBy: disabled ? userId : null,
        })
        .where(
          and(
            connectorInstallationFilter(tenantId, connectorId),
            disabled
              ? isNull(connectorCredentials.disabledAt)
              : isNotNull(connectorCredentials.disabledAt),
          ),
        )
        .returning({
          connectorId: connectorCredentials.connectorId,
          disabledAt: connectorCredentials.disabledAt,
          disabledBy: connectorCredentials.disabledBy,
        });

      if (!row) return null;

      // The WHERE guard above already proves the prior state was the
      // opposite of `disabled` — no separate read needed for beforeSnapshot.
      await writeAuditEntry(tx, {
        tenantId,
        actorId: userId,
        actorType: "user",
        resourceType: "connector_installation",
        resourceId: connectorId,
        action: "updated",
        beforeSnapshot: { disabled: !disabled },
        afterSnapshot: { disabled },
      });

      return row;
    });

    if (!updated) {
      return c.json(
        {
          error: "NOT_FOUND",
          message: "Connector is not installed for this tenant",
        },
        404,
      );
    }

    return c.json({ data: { ...updated, disabled } });
  },
);
