/**
 * Admin Members — docs/specs/oncall-routing.md T17/T18/R3.
 *
 * PR #602 review (Vijit), BLOCKER-1: the on-call roster's primary/backup/
 * escalation-manager pickers were wrongly sourced from GET /users, which
 * deliberately excludes agents and admins (it exists to feed the
 * customer-facing @mention picker). On-call assignment needs the opposite
 * set -- agents and admins, never plain customers -- so this is a separate,
 * admin-only endpoint rather than a role-filter change to /users (which
 * would break its existing customer-only contract).
 */

import { Hono } from "hono";
import { requireAuth, requireRole } from "@platform/auth";
import { db } from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { listMergedOrgUsersByRole } from "../platform/users.js";

type Vars = { Variables: { auth: AuthContext } };

export const membersRouter = new Hono<Vars>();

// GET /admin/members — org users holding "agent" or "admin", for admin-only
// assignment pickers (on-call roster primary/backup/escalation-manager).
membersRouter.get("/", requireAuth(db), requireRole("admin"), async (c) => {
  const { tenantId, orgId } = c.get("auth");
  const merged = await listMergedOrgUsersByRole(
    tenantId,
    orgId,
    ["agent", "admin"],
    c.req.query("bust") === "1",
  );
  return c.json({ data: merged });
});
