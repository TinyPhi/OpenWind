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
 * Roles (owner, 2026-10-21; docs/specs/oncall-routing.md "Roles"): "user" is
 * an employee without admin rights, never a customer. PR #623 had left
 * "user" out because it was then read as the customer role; with that
 * settled, a "user" employee is a valid on-call contact, as they already are
 * a ticket assignee and severity-alert recipient. Sandboxes seed their staff
 * as "user", so without it their roster could only pick the admin. If an org
 * ever holds customer accounts, they need their own role, not "user".
 */

import { Hono } from "hono";
import { requireAuth, requireRole } from "@platform/auth";
import { db } from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { listMergedOrgUsersByRole } from "../platform/users.js";
import { ONCALL_ROLES } from "../../lib/oncall-roles.js";

type Vars = { Variables: { auth: AuthContext } };

export const membersRouter = new Hono<Vars>();

// GET /admin/members — org users holding "agent", "admin", or "user", for
// admin-only assignment pickers (on-call roster primary/backup/
// escalation-manager).
membersRouter.get("/", requireAuth(db), requireRole("admin"), async (c) => {
  const { tenantId, orgId } = c.get("auth");
  const merged = await listMergedOrgUsersByRole(
    tenantId,
    orgId,
    ONCALL_ROLES,
    c.req.query("bust") === "1",
  );
  return c.json({ data: merged });
});
