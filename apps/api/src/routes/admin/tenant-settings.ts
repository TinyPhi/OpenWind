/**
 * Tenant settings routes — per-tenant organization configuration (#1158).
 *
 * GET   /admin/tenant-settings — read the tenant's settings (readable by authenticated tenant users)
 * PATCH /admin/tenant-settings — update the tenant's settings (admin only)
 */

import { z } from "zod";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import { tenantSettings, withTenantContext } from "@platform/db";
import { isValidTimezone } from "@platform/scheduler";
import { writeAuditEntry } from "@platform/audit";
import { logger } from "@platform/logger";
import { zValidator } from "../../lib/validator.js";
import { factory } from "./factory.js";

/**
 * Canonicalize timezone casing without rewriting modern IANA zones to legacy aliases
 * (avoids ICU CLDR rewrites such as Asia/Kolkata -> Asia/Calcutta or Europe/Kyiv -> Europe/Kiev).
 */
export function canonicalizeTimezone(tz: string): string {
  const trimmed = tz.trim();
  if (trimmed.toUpperCase() === "UTC") return "UTC";
  return trimmed
    .split("/")
    .map((seg) =>
      seg
        .split("_")
        .map((part) =>
          part ? part[0]!.toUpperCase() + part.slice(1).toLowerCase() : "",
        )
        .join("_"),
    )
    .join("/");
}

export const PatchTenantSettingsSchema = z.object({
  defaultTimezone: z
    .string()
    .trim()
    .max(64)
    .nullable()
    .refine(
      (tz) => {
        if (tz === null) return true;
        if (!isValidTimezone(tz)) return false;
        // Reject inverted Etc/GMT zones or legacy ambiguous zones
        if (tz.startsWith("Etc/GMT") || tz.includes(" ")) return false;
        return true;
      },
      {
        message: "Invalid or unsupported IANA timezone identifier",
      },
    ),
});

export const getTenantSettingsHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const { tenantId } = c.get("auth");
    try {
      const data = await withTenantContext(tenantId, async (tx) => {
        const [row] = await tx
          .select({
            defaultTimezone: tenantSettings.defaultTimezone,
          })
          .from(tenantSettings)
          .where(eq(tenantSettings.tenantId, tenantId))
          .limit(1);

        return {
          defaultTimezone: row?.defaultTimezone ?? null,
        };
      });

      return c.json({ data });
    } catch (err: unknown) {
      logger.error({ err, tenantId }, "getTenantSettings failed");
      return c.json(
        { error: "INTERNAL_ERROR", message: "Failed to load tenant settings" },
        500,
      );
    }
  },
);

export const updateTenantSettingsHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("json", PatchTenantSettingsSchema),
  async (c) => {
    const { defaultTimezone } = c.req.valid("json");
    const { userId, tenantId } = c.get("auth");

    try {
      const data = await withTenantContext(tenantId, async (tx) => {
        // Read with row lock to prevent race conditions on concurrent saves (G4)
        const [before] = await tx
          .select({
            defaultTimezone: tenantSettings.defaultTimezone,
          })
          .from(tenantSettings)
          .where(eq(tenantSettings.tenantId, tenantId))
          .for("update")
          .limit(1);

        // Canonicalize valid timezone identifiers (e.g. "asia/kolkata" -> canonical IANA zone) (G5)
        const canonicalTimezone = defaultTimezone
          ? canonicalizeTimezone(defaultTimezone)
          : null;

        const [row] = await tx
          .insert(tenantSettings)
          .values({
            tenantId,
            defaultTimezone: canonicalTimezone,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: tenantSettings.tenantId,
            set: {
              defaultTimezone: canonicalTimezone,
              updatedAt: new Date(),
            },
          })
          .returning();

        if (!row) {
          throw new Error("Failed to save tenant settings");
        }

        // Only write audit entry if the setting actually changed (G4)
        const previousTimezone = before?.defaultTimezone ?? null;
        if (previousTimezone !== row.defaultTimezone) {
          await writeAuditEntry(tx, {
            tenantId,
            actorId: userId,
            actorType: "user",
            resourceType: "tenant_settings",
            resourceId: tenantId,
            action: "updated",
            beforeSnapshot: { defaultTimezone: previousTimezone },
            afterSnapshot: { defaultTimezone: row.defaultTimezone },
          });
        }

        return {
          defaultTimezone: row.defaultTimezone,
        };
      });

      return c.json({ data });
    } catch (err: unknown) {
      logger.error({ err, tenantId }, "updateTenantSettings failed");
      return c.json(
        {
          error: "INTERNAL_ERROR",
          message: "Failed to update tenant settings",
        },
        500,
      );
    }
  },
);
