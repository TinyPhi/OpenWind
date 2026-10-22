import { z } from "zod";
import { zValidator } from "../../lib/validator.js";
import {
  requirePlatformAdmin,
  requireFreshMfa,
  lookupOrgIdByTenantId,
  listOrgUsers,
  setUserOrgMetadata,
  sandboxOrgPlacement,
} from "@platform/auth";
import { db, tenants, withPlatformAdminContext } from "@platform/db";
import {
  runOrgDirectorySync,
  ZitadelOrgSourceImporter,
} from "@platform/org-directory";
import { eq } from "drizzle-orm";
import { logger } from "@platform/logger";
import { platformAdminFactory } from "./factory.js";

/**
 * Seeds (or re-seeds) a sandbox's org chart with the default department/reporting structure
 * (docs/specs/multi-org-sandbox.md R3): writes department, title and manager_id to each Zitadel
 * user's metadata, then runs the org-directory sync so the chart rebuilds from it. For sandboxes
 * provisioned before the structure was seeded at creation. Deterministic: users are ordered by
 * name, so running it again produces the same chart. It overwrites those three metadata keys
 * for every user in the sandbox's org.
 *
 * Done inline rather than on a queue: it is one metadata write per account (10-20) plus a
 * sync. A race with the org-directory sync is handled by that sync's own advisory lock.
 */
const TenantIdParamSchema = z.object({ tenantId: z.string().uuid() });

const importer = new ZitadelOrgSourceImporter();

export const sandboxOrgTreeHandler = platformAdminFactory.createHandlers(
  requirePlatformAdmin(),
  requireFreshMfa(),
  zValidator("param", TenantIdParamSchema),
  async (c) => {
    const { userId } = c.get("platformAdmin");
    const { tenantId } = c.req.valid("param");

    // 404, not 403, for "no such tenant" and "not a sandbox" (security.md 404-not-403 rule).
    const [tenant] = await withPlatformAdminContext((tx) =>
      tx
        .select({ id: tenants.id, isSandbox: tenants.isSandbox })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1),
    );
    if (!tenant?.isSandbox) {
      return c.json({ error: "NOT_FOUND", message: "No such sandbox" }, 404);
    }

    const orgId = await lookupOrgIdByTenantId(tenantId, db);
    if (!orgId) {
      return c.json({ error: "NOT_FOUND", message: "No such sandbox" }, 404);
    }

    const users = (await listOrgUsers(orgId)).sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
    if (users.length === 0) {
      return c.json(
        { error: "NO_USERS", message: "This sandbox has no accounts to place" },
        409,
      );
    }

    let failed = 0;
    for (const [position, user] of users.entries()) {
      const placement = sandboxOrgPlacement(position);
      const manager =
        placement.reportsTo === null ? null : users[placement.reportsTo];
      const ok = await setUserOrgMetadata(user.userId, {
        managerId: manager?.userId ?? null,
        department: placement.department,
        title: placement.title,
      });
      if (!ok) failed++;
    }

    const sync = await runOrgDirectorySync(tenantId, importer, userId);

    logger.info(
      {
        tenantId,
        actorId: userId,
        accounts: users.length,
        failed,
        syncStatus: sync.status,
      },
      "Sandbox org chart seeded",
    );

    if (failed > 0 || sync.status === "failed") {
      return c.json(
        {
          error: "SEED_INCOMPLETE",
          message:
            "Some accounts could not be updated or the org chart sync failed — try again",
        },
        502,
      );
    }
    return c.json({
      data: { accounts: users.length, syncStatus: sync.status },
    });
  },
);
