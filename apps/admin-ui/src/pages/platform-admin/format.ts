/**
 * Shared shapes + formatting for the platform-admin dashboard. The shapes mirror the API's
 * allow-listed views (packages/db platform-admin-view.ts / platform-admin-audit.ts) -- the
 * dashboard never sees more than those fields.
 */
import type { TFunction } from "i18next";

export type TrialStatus = "none" | "active" | "expired";

export interface SandboxView {
  id: string;
  name: string;
  isSandbox: boolean;
  createdAt: string;
  trialStatus: TrialStatus;
  trialEndsAt: string | null;
  logo: string | null;
  loginKey: string | null;
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

export const ACTION_LABEL_KEY: Record<PlatformAdminAction, string> = {
  "sandbox.created": "platformAdmin.format.sandboxCreated",
  "sandbox.reset": "platformAdmin.format.sandboxReset",
  "sandbox.deleted": "platformAdmin.format.sandboxDeleted",
  "sandbox.trial_changed": "platformAdmin.format.trialExtended",
  "sandbox.trial_ended": "platformAdmin.format.trialEnded",
  "sandbox.branding_changed": "platformAdmin.format.brandingChanged",
};

export function actionLabel(t: TFunction, action: PlatformAdminAction): string {
  return t(ACTION_LABEL_KEY[action]);
}

export const TRIAL_BADGE: Record<
  TrialStatus,
  { labelKey: string; cls: string }
> = {
  active: { labelKey: "platformAdmin.trialActive", cls: "badge-success" },
  expired: { labelKey: "platformAdmin.trialExpired", cls: "badge-warning" },
  none: { labelKey: "platformAdmin.noTrial", cls: "badge-muted" },
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(
  t: TFunction,
  iso: string,
  now: number = Date.now(),
): string {
  const diff = now - Date.parse(iso);
  if (diff < MINUTE) return t("platformAdmin.format.justNow");
  if (diff < HOUR)
    return t("platformAdmin.format.minutesAgo", {
      count: Math.floor(diff / MINUTE),
    });
  if (diff < DAY)
    return t("platformAdmin.format.hoursAgo", {
      count: Math.floor(diff / HOUR),
    });
  if (diff < 30 * DAY)
    return t("platformAdmin.format.daysAgo", {
      count: Math.floor(diff / DAY),
    });
  return new Date(iso).toLocaleDateString();
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayLabel(
  t: TFunction,
  iso: string,
  now: number = Date.now(),
): string {
  const days = Math.round(
    (startOfDay(now) - startOfDay(Date.parse(iso))) / DAY,
  );
  if (days === 0) return t("platformAdmin.format.today");
  if (days === 1) return t("platformAdmin.format.yesterday");
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Groups newest-first entries into consecutive day buckets, preserving order. */
export function groupByDay(
  t: TFunction,
  entries: AuditEntry[],
  now: number = Date.now(),
): { label: string; entries: AuditEntry[] }[] {
  const groups: { label: string; entries: AuditEntry[] }[] = [];
  for (const entry of entries) {
    const label = dayLabel(t, entry.createdAt, now);
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
  t: TFunction,
  trialEndsAt: string | null,
  now: number = Date.now(),
): string {
  if (!trialEndsAt) return t("platformAdmin.format.noTrial");
  const diff = Date.parse(trialEndsAt) - now;
  const days = Math.floor(Math.abs(diff) / DAY);
  if (diff > 0) {
    if (days === 0) return t("platformAdmin.format.endsToday");
    return t("platformAdmin.format.daysLeft", { count: days });
  }
  if (days === 0) return t("platformAdmin.format.expiredToday");
  return t("platformAdmin.format.expiredDaysAgo", { count: days });
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
