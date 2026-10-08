import { getRedis } from "@platform/redis";

/**
 * docs/specs/multi-org-sandbox.md T21. Security review (PR3): the handover artifact (seeded
 * usernames + the shared password Zitadel actually has on file) must NOT be a durable
 * Postgres column -- a column with a blanket `platform_admin_role` GRANT and no retention
 * policy would let any current or future platform_admin recover every sandbox's working
 * credentials indefinitely, long after the sandbox should be considered decommissioned. This
 * mirrors platform-admin-mfa.ts's reasoning for keeping admin secrets in Redis rather than
 * Postgres, though for the opposite failure direction: MFA must fail CLOSED on a Redis
 * outage, but a missing/expired handover record here is just "the window passed" -- not a
 * security control being bypassed -- so no fail-closed wrapper is needed.
 *
 * TTL, not "forever" and not "the ~1h BullMQ job-result window this replaces": long enough to
 * cover a sales demo handed off over days, short enough to bound a compromised platform_admin
 * session's exposure to recently-provisioned sandboxes only.
 */
const HANDOVER_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function handoverKey(tenantId: string): string {
  return `platform-admin:sandbox-handover:${tenantId}`;
}

export interface SandboxHandoverCredentials {
  seededAccounts: { email: string; role: "admin" | "member" }[];
  defaultPassword: string;
}

export async function storeSandboxHandoverCredentials(
  tenantId: string,
  credentials: SandboxHandoverCredentials,
): Promise<void> {
  const redis = getRedis();
  await redis.set(
    handoverKey(tenantId),
    JSON.stringify(credentials),
    "EX",
    HANDOVER_TTL_SECONDS,
  );
}

/** Returns null once the TTL has passed or if nothing was ever stored for this tenant --
 * both cases are "handover window expired or never existed", not a Redis-outage distinction
 * the caller needs to make (a transient Redis error just propagates and surfaces as a 5xx,
 * same as any other unexpected read failure in this route tree). */
export async function getSandboxHandoverCredentials(
  tenantId: string,
): Promise<SandboxHandoverCredentials | null> {
  const redis = getRedis();
  const raw = await redis.get(handoverKey(tenantId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SandboxHandoverCredentials;
  } catch {
    return null;
  }
}
