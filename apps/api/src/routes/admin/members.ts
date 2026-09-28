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
 * PR #623 review (Vijit), round 2 BLOCKER-1: the role set was briefly
 * expanded to ["agent", "admin", "user"] on the premise that this
 * deployment has no "agent" role in use -- but "user" is specifically the
 * customer role (see platform/users.ts's GET /users: "Only surface users
 * holding the 'user' role -- agents/admins must never appear"). Including
 * it here let customers be selected as on-call primary/backup/escalation
 * contacts, so they'd receive incident routing alerts. Reverted to
 * ["agent", "admin"] -- on-call staff without an "agent" role assignment
 * in this deployment should be granted "admin" (or a dedicated "agent"
 * role) in Zitadel instead of loosening this endpoint to customers.
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
// Never "user" -- that's the customer role (see comment above).
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
