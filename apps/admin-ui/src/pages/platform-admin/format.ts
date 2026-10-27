/**
 * Shared shapes + formatting for the platform-admin dashboard. The shapes mirror the API's
 * allow-listed views (packages/db platform-admin-view.ts / platform-admin-audit.ts) -- the
 * dashboard never sees more than those fields.
 */

export type TrialStatus = "none" | "active" | "expired";

export interface SandboxView {
  id: string;
  name: string;
  isSandbox: boolean;
  createdAt: string;
  trialStatus: TrialStatus;
  trialEndsAt: string | null;
  logo: string | null;
}

export type PlatformAdminAction =
  | "sandbox.created"
  | "sandbox.reset"
  | "sandbox.deleted"
  | "sandbox.trial_changed"
  | "sandbox.trial_ended"
  | "sandbox.branding_changed";

export interface AuditEntry {
  id: string;
  actorSub: string;
  action: PlatformAdminAction;
  targetTenantId: string;
  createdAt: string;
}

export const ACTION_LABEL: Record<PlatformAdminAction, string> = {
  "sandbox.created": "Created sandbox",
  "sandbox.reset": "Reset sandbox",
  "sandbox.deleted": "Deleted sandbox",
  "sandbox.trial_changed": "Extended trial",
  "sandbox.trial_ended": "Ended trial",
  "sandbox.branding_changed": "Changed branding",
};

export const TRIAL_BADGE: Record<TrialStatus, { label: string; cls: string }> =
  {
    active: { label: "Trial active", cls: "badge-success" },
    expired: { label: "Trial expired", cls: "badge-warning" },
    none: { label: "No trial", cls: "badge-muted" },
  };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = now - Date.parse(iso);
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayLabel(iso: string, now: number = Date.now()): string {
  const days = Math.round(
    (startOfDay(now) - startOfDay(Date.parse(iso))) / DAY,
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Groups newest-first entries into consecutive day buckets, preserving order. */
export function groupByDay(
  entries: AuditEntry[],
  now: number = Date.now(),
): { label: string; entries: AuditEntry[] }[] {
  const groups: { label: string; entries: AuditEntry[] }[] = [];
  for (const entry of entries) {
    const label = dayLabel(entry.createdAt, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Short trial countdown for a row: "5 days left", "Ends today", "Expired 2 days ago". */
export function trialCountdown(
  trialEndsAt: string | null,
  now: number = Date.now(),
): string {
  if (!trialEndsAt) return "No trial";
  const diff = Date.parse(trialEndsAt) - now;
  const days = Math.floor(Math.abs(diff) / DAY);
  if (diff > 0) {
    if (days === 0) return "Ends today";
    return `${days} day${days === 1 ? "" : "s"} left`;
  }
  if (days === 0) return "Expired today";
  return `Expired ${days} day${days === 1 ? "" : "s"} ago`;
}

export function isExpiringSoon(
  trialEndsAt: string | null,
  now: number = Date.now(),
  withinDays = 7,
): boolean {
  if (!trialEndsAt) return false;
  const diff = Date.parse(trialEndsAt) - now;
  return diff > 0 && diff <= withinDays * DAY;
}
