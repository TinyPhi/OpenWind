import { getRedis } from "@platform/redis";

/**
 * docs/specs/multi-org-sandbox.md T21. Security review (PR3): the handover artifact (seeded
 * usernames + each account's password Zitadel actually has on file) must NOT be a durable
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

export interface SandboxSeededAccount {
  username: string;
  email: string;
  role: "admin" | "user";
  password: string;
}

export interface SandboxHandoverCredentials {
  seededAccounts: SandboxSeededAccount[];
}

// Handovers written before per-account passwords (2026-10-14) carry one sandbox-wide
// defaultPassword and no per-account password; they stay readable until their 7-day TTL ends.
interface StoredSandboxHandover {
  seededAccounts: (Omit<SandboxSeededAccount, "password"> & {
    password?: string;
  })[];
  defaultPassword?: string;
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
  let stored: StoredSandboxHandover | null;
  try {
    // Shape written by storeSandboxHandoverCredentials (or its pre-2026-10-14 version).
    stored = JSON.parse(raw) as StoredSandboxHandover | null;
  } catch {
    return null;
  }
  if (!stored || !Array.isArray(stored.seededAccounts)) return null;
  const seededAccounts: SandboxSeededAccount[] = [];
  for (const account of stored.seededAccounts) {
    const password = account.password ?? stored.defaultPassword;
    // An account with no password on file can't be handed over; treat the record as unusable.
    if (!password) return null;
    seededAccounts.push({ ...account, password });
  }
  return { seededAccounts };
}

/**
 * T14 (docs/specs/multi-org-sandbox.md) -- without this, a purged sandbox's handover
 * credentials (its seeded admin password) stay retrievable from Redis for up to 7 more
 * days, relying solely on the TTL -- R8's "delete this org's data" means now, not
 * eventually. Called from apps/worker/src/tenant-purge.ts; a no-op if nothing was ever
 * stored for this tenant (real tenants never have a handover key in the first place).
 */
export async function deleteSandboxHandoverCredentials(
  tenantId: string,
): Promise<void> {
  const redis = getRedis();
  await redis.del(handoverKey(tenantId));
}
