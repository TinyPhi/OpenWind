/**
 * Org Directory routes — docs/specs/org-directory.md T5, T6, R7.
 *
 * Reads (GET) are any-authenticated-tenant-user, per the spec's visibility
 * decision. The manual "sync now" trigger is admin-only. This route never
 * imports a Zitadel client directly — ZitadelOrgSourceImporter is the only
 * thing here that knows an auth provider exists, and only for the sync
 * trigger; every read goes through @platform/org-directory's query API,
 * which only ever touches this platform's own tables.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "../lib/validator.js";
import type { AuthContext } from "@platform/auth";
import { requireAuth, requireRole } from "@platform/auth";
import { db } from "@platform/db";
import {
  getOrgTree,
  getChainToRoot,
  getReportsByLevel,
  getSyncStatus,
  runOrgDirectorySync,
  ZitadelOrgSourceImporter,
} from "@platform/org-directory";
import { writeAuditEntry } from "@platform/audit";
import { logger } from "@platform/logger";

type Vars = { Variables: { auth: AuthContext } };

const router = new Hono<Vars>();

router.use("*", requireAuth(db));

const UserIdParamSchema = z.object({ userId: z.string().min(1) });

const importer = new ZitadelOrgSourceImporter();

router.get("/tree", async (c) => {
  const auth = c.get("auth");
  const tree = await getOrgTree(auth.tenantId);
  return c.json({ data: tree });
});

router.get(
  "/chain/:userId",
  zValidator("param", UserIdParamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { userId } = c.req.valid("param");
    const chain = await getChainToRoot(auth.tenantId, userId);
    return c.json({ data: chain });
  },
);

router.get(
  "/reports/:userId",
  zValidator("param", UserIdParamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { userId } = c.req.valid("param");
    const levels = await getReportsByLevel(auth.tenantId, userId);
    return c.json({ data: levels });
  },
);

router.get("/sync-status", async (c) => {
  const auth = c.get("auth");
  const status = await getSyncStatus(auth.tenantId);
  return c.json({ data: status });
});

// POST /org-directory/sync — admin-only manual trigger (R7). Returns 200
// with an "already_running" status rather than a 409 -- this is expected,
// routine steady state (an admin clicking "sync now" while the 24h
// background job happens to be mid-run), not a conflict the client did
// anything wrong to cause.
router.post("/sync", requireRole("admin"), async (c) => {
  const auth = c.get("auth");
  const result = await runOrgDirectorySync(
    auth.tenantId,
    importer,
    auth.userId,
  );

  if (result.status === "failed") {
    logger.error(
      { tenantId: auth.tenantId },
      "org-directory: admin-triggered sync failed",
    );
    // An admin-triggered write that failed is exactly the case compliance/
    // incident review needs an audit record for -- logger output alone
    // rotates and isn't the system of record (review finding, PR722).
    await writeAuditEntry(db, {
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorType: "user",
      action: "sync_failed",
      resourceType: "org_directory",
      resourceId: auth.tenantId,
      metadata: { trigger: "manual" },
    });
  } else if (result.status === "completed") {
    await writeAuditEntry(db, {
      tenantId: auth.tenantId,
      actorId: auth.userId,
      actorType: "user",
      action: "updated",
      resourceType: "org_directory",
      resourceId: auth.tenantId,
      metadata: { employeeCount: result.employeeCount, trigger: "manual" },
    });
  }

  return c.json({ data: result });
});

export { router as orgDirectoryRouter };
