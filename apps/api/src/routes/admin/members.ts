/**
 * Admin Members — docs/specs/oncall-routing.md T17/T18/R3.
 *
 * PR #602 review (Vijit), BLOCKER-1: the on-call roster's primary/backup/
 * escalation-manager pickers were wrongly sourced from GET /users, which
 * is the customer-facing @mention picker -- it excludes admins so admins
 * don't get @mentioned like customers. On-call assignment needs a
 * separate, admin-only endpoint rather than a role-filter change to
 * /users (which would break its existing customer-only contract).
 *
 * Role set: this deployment only has "admin" and "user" roles (no "agent"
 * role in use), so on-call assignees are drawn from both -- any
 * authenticated org member can be an on-call assignee, not just admins.
 */

import { Hono } from "hono";
import { requireAuth, requireRole } from "@platform/auth";
import { db } from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { listMergedOrgUsersByRole } from "../platform/users.js";

type Vars = { Variables: { auth: AuthContext } };

export const membersRouter = new Hono<Vars>();

// GET /admin/members — org users holding "agent", "admin", or "user", for
// admin-only assignment pickers (on-call roster primary/backup/escalation-manager).
membersRouter.get("/", requireAuth(db), requireRole("admin"), async (c) => {
  const { tenantId, orgId } = c.get("auth");
  const merged = await listMergedOrgUsersByRole(
    tenantId,
    orgId,
    ["agent", "admin", "user"],
    c.req.query("bust") === "1",
  );
  return c.json({ data: merged });
});
