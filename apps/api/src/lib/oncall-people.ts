import type { Context } from "hono";
import type { AuthContext } from "@platform/auth";
import { logger } from "@platform/logger";
import { resolveTenantMembers } from "./ensure-user-refs.js";
import { listUserRolesByUserId } from "./zitadel-management.js";
import { ONCALL_ROLES } from "./oncall-roles.js";

export const NOT_ONCALL_MESSAGE =
  "This person doesn't hold an on-call role (admin, agent or user)";

export type PeopleCheck =
  | { status: "unavailable" }
  | { status: "checked"; errors: { field: string; message: string }[] };

export type PickedPerson = { field: string; userId: string };

// Every person must hold an on-call role in the live Zitadel org, whether or
// not they have signed in (on-call spec R13a), and anyone who hasn't signed in
// yet is recorded in tenant_users. Runs with no transaction open, so the
// Zitadel lookups never hold a database connection (#952). Without an org
// there is nobody to confirm, so every pick is refused. A user id from another
// org is simply "not on call" here, never confirmed to exist.
export async function checkPeopleAreOnCall(
  auth: AuthContext,
  picks: readonly PickedPerson[],
): Promise<PeopleCheck> {
  if (picks.length === 0) return { status: "checked", errors: [] };

  let rolesByUserId = new Map<string, string[]>();
  if (auth.orgId) {
    try {
      rolesByUserId = await listUserRolesByUserId(auth.orgId);
    } catch (err: unknown) {
      logger.warn(
        { err, tenantId: auth.tenantId, orgId: auth.orgId },
        "on-call people check: zitadel role lookup failed; refusing the write",
      );
      return { status: "unavailable" };
    }
  }
  const isOnCall = (id: string): boolean =>
    (rolesByUserId.get(id) ?? []).some((r) => ONCALL_ROLES.includes(r));

  const errors = picks
    .filter((p) => !isOnCall(p.userId))
    .map((p) => ({ field: p.field, message: NOT_ONCALL_MESSAGE }));
  if (errors.length > 0) return { status: "checked", errors };

  await resolveTenantMembers(
    auth.tenantId,
    picks.map((p) => p.userId),
    auth.orgId,
  );
  return { status: "checked", errors: [] };
}

export function peopleCheckResponse(
  c: Context<{ Variables: { auth: AuthContext } }>,
  check: PeopleCheck,
): Response | null {
  if (check.status === "unavailable") {
    return c.json(
      {
        error: "SERVICE_UNAVAILABLE",
        message: "Couldn't check people's roles just now. Try again shortly.",
      },
      503,
    );
  }
  if (check.errors.length > 0) {
    return c.json(
      {
        error: "VALIDATION_ERROR",
        message: "Validation failed",
        fields: check.errors,
      },
      422,
    );
  }
  return null;
}
