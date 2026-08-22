export type ApiKeyRow = {
  id: string;
  name: string;
  scopes: string[];
  scopesFormat: "role" | "action";
  applicationName: string | null;
  applicationDescription: string | null;
  applicationContactEmail: string | null;
  rotatedFrom: string | null;
  createdAt: string;
  createdBy: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

export type ApiKeyStatus = "active" | "rotating" | "expired" | "revoked";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Spec R10: status is always derived from revokedAt/expiresAt/rotatedFrom —
 * never a stored field (ADR-012 Phase A §I explicitly rejected a `status`
 * column as a second source of truth that could drift from these).
 *
 * "rotating" means THIS key is the dying predecessor still inside its 24h
 * grace window (ADR-008 Decision #3) — identified by another, still-live key
 * in the same list pointing rotatedFrom back at it. The new successor key
 * itself is simply "active" from the moment of rotation (spec R3).
 */
export function computeApiKeyStatus(
  key: ApiKeyRow,
  allKeys: readonly ApiKeyRow[],
  now: Date = new Date(),
): ApiKeyStatus {
  if (key.revokedAt !== null) return "revoked";
  if (key.expiresAt !== null && new Date(key.expiresAt) <= now)
    return "expired";
  const hasLiveSuccessor = allKeys.some(
    (other) =>
      other.rotatedFrom === key.id &&
      other.revokedAt === null &&
      (other.expiresAt === null || new Date(other.expiresAt) > now),
  );
  if (hasLiveSuccessor) return "rotating";
  return "active";
}

export type ExpiryBadge = { level: "none" | "amber" | "red"; label: string };

/** Spec R10 — computed client-side from expiresAt, no new backend field. */
export function computeExpiryBadge(
  expiresAt: string | null,
  now: Date = new Date(),
): ExpiryBadge {
  if (expiresAt === null) return { level: "none", label: "" };
  const expiry = new Date(expiresAt);
  const msRemaining = expiry.getTime() - now.getTime();
  if (msRemaining <= 0) return { level: "red", label: "Expired" };
  if (msRemaining <= THIRTY_DAYS_MS) {
    const days = Math.max(1, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)));
    return {
      level: "amber",
      label: `Expires in ${days} day${days !== 1 ? "s" : ""}`,
    };
  }
  return { level: "none", label: "" };
}

export function summarizeScopes(
  scopes: readonly string[],
  scopesFormat: "role" | "action",
): string {
  if (scopesFormat === "role") return scopes.join(", ") || "—";
  const READ_ONLY = ["entity:ticket:read"];
  const READ_WRITE = [
    "entity:ticket:create",
    "entity:ticket:read",
    "entity:ticket:comment",
    "entity:ticket:transition",
    "entity:ticket:subticket",
    "entity:ticket:attach",
  ];
  const sorted = [...scopes].sort();
  if (
    sorted.length === READ_ONLY.length &&
    sorted.every((s, i) => s === [...READ_ONLY].sort()[i])
  )
    return "Read-only";
  if (
    sorted.length === READ_WRITE.length &&
    sorted.every((s, i) => s === [...READ_WRITE].sort()[i])
  )
    return "Read-write";
  return `Custom (${scopes.length} scope${scopes.length !== 1 ? "s" : ""})`;
}
