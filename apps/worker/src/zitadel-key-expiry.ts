/**
 * Daily Zitadel machine-key expiry digest (docs/deployment-hardening.md, "Zitadel machine-key
 * rotation"). Rotation is manual; this is its guard rail. Each run asks Zitadel for the live
 * expiry of every configured key and emails OPS_ALERT_EMAIL ONE digest covering all of them --
 * the keys are rotated together, so they share an expiry -- but only when something changed
 * (a key crossed a threshold, was replaced, or went missing). Expired, missing and unknown
 * keys repeat daily, never-expiring ones weekly, so a problem is not reported once and then
 * forgotten. Every run also logs a summary and leaves the result in Redis for the
 * days-remaining gauge, so the notification key expiring (which stops email) still shows up.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { checkMachineKeyExpiry, type MachineKeyExpiry } from "@platform/auth";
import { sendDirectNotification } from "@platform/notifications";
import { getRedis } from "@platform/redis";
import { env } from "@platform/config";
import { logger } from "@platform/logger";
import { Worker, Queue } from "@platform/telemetry";
import { connection } from "./queues.js";

const QUEUE_NAME = "zitadel-key-expiry";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Read by the telemetry gauges (packages/telemetry/src/metrics.ts). */
export const KEY_EXPIRY_REPORT_KEY = "ops:zitadel-key-expiry:report";
const LAST_DIGEST_KEY = "ops:zitadel-key-expiry:last-digest";
// The report outlives a missed run or two, then disappears, so a check that stopped running
// shows up as an absent metric rather than a frozen, healthy-looking one.
const REPORT_TTL_SECONDS = 3 * 24 * 60 * 60;

const LastDigestSchema = z.object({
  fingerprint: z.string(),
  sentAt: z.number().int().nonnegative(),
});

/**
 * The previous digest, or null if there is none -- or if what's stored is unreadable or
 * claims a send in the future. Either way the next digest goes out rather than staying
 * suppressed by bad state.
 */
export function parseLastDigest(
  raw: string | null,
  now: Date,
): { fingerprint: string; sentAt: number } | null {
  if (!raw) return null;
  try {
    const parsed = LastDigestSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.sentAt <= now.getTime()
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

/** A stable, distinct recipient id per address: the delivery service keys subscribers by it. */
export function opsRecipientId(email: string): string {
  return `ops-alert:${createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 16)}`;
}

// The warning steps, most urgent last.
const WARN_DAYS = [30, 14, 7, 3, 1] as const;

// A key that outlives this is long-lived in practice (one found locally expired in 2035): rotation
// should leave every key with a short expiry, so anything longer is reported like no expiry.
const LONG_LIVED_AFTER_DAYS = 365;

export type KeyStatus =
  | "ok"
  | `warn_${(typeof WARN_DAYS)[number]}`
  | "expired"
  | "long_lived"
  | "never_expires"
  | "missing"
  | "unknown";

export interface KeyRow {
  name: string;
  keyIdSuffix: string;
  status: KeyStatus;
  expiresAt: string | null;
  daysLeft: number | null;
  reason?: string;
}

// How often an unchanged digest is sent again, per status. Others are sent only on change.
const REPEAT_AFTER_MS: Partial<Record<KeyStatus, number>> = {
  expired: DAY_MS,
  missing: DAY_MS,
  unknown: DAY_MS,
  never_expires: 7 * DAY_MS,
  long_lived: 7 * DAY_MS,
};
// A run a little early (job jitter, a restart) must not skip a repeat for a whole day.
const REPEAT_SLACK_MS = 60 * 60 * 1000;

export function toRow(report: MachineKeyExpiry, now: Date): KeyRow {
  const base = { name: report.name, keyIdSuffix: report.keyIdSuffix };
  if (report.state === "never_expires") {
    return {
      ...base,
      status: "never_expires",
      expiresAt: null,
      daysLeft: null,
    };
  }
  if (report.state === "missing") {
    return { ...base, status: "missing", expiresAt: null, daysLeft: null };
  }
  if (report.state === "unknown") {
    return {
      ...base,
      status: "unknown",
      expiresAt: null,
      daysLeft: null,
      reason: report.reason,
    };
  }
  const msLeft = report.expiresAt.getTime() - now.getTime();
  const daysLeft = Math.floor(msLeft / DAY_MS);
  let status: KeyStatus = "ok";
  if (msLeft <= 0) {
    status = "expired";
  } else if (daysLeft > LONG_LIVED_AFTER_DAYS) {
    status = "long_lived";
  } else {
    for (const d of WARN_DAYS) if (daysLeft < d) status = `warn_${d}`;
  }
  return {
    ...base,
    status,
    expiresAt: report.expiresAt.toISOString(),
    daysLeft,
  };
}

/** Identifies the digest's content: which key is in which state. Dates move daily; states don't. */
export function digestFingerprint(rows: KeyRow[]): string {
  return createHash("sha256")
    .update(
      rows
        .map((r) => `${r.name}:${r.keyIdSuffix}:${r.status}`)
        .sort()
        .join("|"),
    )
    .digest("hex")
    .slice(0, 16);
}

export function shouldSendDigest(
  rows: KeyRow[],
  last: { fingerprint: string; sentAt: number } | null,
  now: Date,
): boolean {
  const fingerprint = digestFingerprint(rows);
  if (!last) return rows.some((r) => r.status !== "ok");
  if (last.fingerprint !== fingerprint) return true;
  const since = now.getTime() - last.sentAt;
  return rows.some((r) => {
    const repeat = REPEAT_AFTER_MS[r.status];
    return repeat !== undefined && since >= repeat - REPEAT_SLACK_MS;
  });
}

const STATUS_LABEL: Record<KeyStatus, string> = {
  ok: "OK",
  warn_30: "Expires within 30 days",
  warn_14: "Expires within 14 days",
  warn_7: "Expires within 7 days",
  warn_3: "Expires within 3 days",
  warn_1: "Expires within 1 day",
  expired: "EXPIRED",
  long_lived: "Expires in more than a year: rotate it with a shorter expiry",
  never_expires: "Never expires: rotate it and set an expiry",
  missing: "Not found in Zitadel: deleted or stale configuration",
  unknown: "Could not be checked",
};

export function buildDigest(
  rows: KeyRow[],
  now: Date,
): { title: string; body: string } {
  const attention = rows.filter((r) => r.status !== "ok").length;
  const title =
    attention === 0
      ? "OpenWind: all Zitadel machine keys are OK"
      : `OpenWind: ${attention} of ${rows.length} Zitadel machine keys need attention`;
  const lines = rows.map((r) => {
    const when =
      r.expiresAt === null
        ? "no expiry date"
        : `expires ${r.expiresAt.slice(0, 10)} (${r.daysLeft === null || r.daysLeft < 0 ? "expired" : `${r.daysLeft} days left`})`;
    const reason = r.reason ? ` [${r.reason}]` : "";
    return `- ${r.name} (key ...${r.keyIdSuffix}): ${when}. ${STATUS_LABEL[r.status]}${reason}`;
  });
  const body = [
    `Zitadel machine-key check, ${now.toISOString().slice(0, 10)}:`,
    "",
    ...lines,
    "",
    attention === 0
      ? "Nothing to do."
      : 'Rotate all keys together, with an expiry date: docs/deployment-hardening.md, "Zitadel machine-key rotation".',
  ].join("\n");
  return { title, body };
}

function alertRecipients(): string[] {
  return (env.OPS_ALERT_EMAIL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function runZitadelKeyExpiryCheck(
  now: Date = new Date(),
): Promise<void> {
  const rows = (await checkMachineKeyExpiry(now)).map((r) => toRow(r, now));
  const redis = getRedis();

  logger.info(
    {
      keys: rows.map(({ name, status, daysLeft, reason }) => ({
        name,
        status,
        daysLeft,
        reason,
      })),
    },
    "zitadel-key-expiry: check complete",
  );
  await redis.set(
    KEY_EXPIRY_REPORT_KEY,
    JSON.stringify({ checkedAt: now.toISOString(), rows }),
    "EX",
    REPORT_TTL_SECONDS,
  );

  if (rows.length === 0) return;
  const lastRaw = await redis.get(LAST_DIGEST_KEY);
  const last = parseLastDigest(lastRaw, now);
  if (!shouldSendDigest(rows, last, now)) return;

  const recipients = alertRecipients();
  if (recipients.length === 0) {
    logger.warn(
      {},
      "zitadel-key-expiry: digest due but OPS_ALERT_EMAIL is not set; not emailed",
    );
    return;
  }

  const fingerprint = digestFingerprint(rows);
  const { title, body } = buildDigest(rows, now);
  await sendDirectNotification({
    notificationId: `ops-zitadel-key-expiry:${fingerprint}:${now.getTime()}`,
    title,
    body,
    recipients: recipients.map((email) => ({
      userId: opsRecipientId(email),
      email,
    })),
  });
  // Recorded only after a successful send, so a failed send is retried on the next run.
  await redis.set(
    LAST_DIGEST_KEY,
    JSON.stringify({ fingerprint, sentAt: now.getTime() }),
  );
  logger.info(
    { fingerprint, recipientCount: recipients.length },
    "zitadel-key-expiry: digest sent",
  );
}

export const zitadelKeyExpiryWorker = new Worker(
  QUEUE_NAME,
  async () => {
    await runZitadelKeyExpiryCheck();
  },
  { connection },
);

zitadelKeyExpiryWorker.on("failed", (_job, err) => {
  logger.error({ err: String(err) }, "zitadel-key-expiry: worker job failed");
});

/**
 * Daily at 06:00, plus once at worker start: a rotation ends with a restart, so the new keys'
 * dates are confirmed straight away (an unchanged result sends nothing).
 */
export async function scheduleZitadelKeyExpiryCheck(): Promise<void> {
  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.add(
    "check",
    {},
    { repeat: { pattern: "0 6 * * *" }, jobId: "zitadel-key-expiry-recurring" },
  );
  await queue.add(
    "check-on-start",
    {},
    { removeOnComplete: true, removeOnFail: 50 },
  );
  await queue.close();
  logger.info({}, "zitadel-key-expiry: scheduled (daily 06:00 and on start)");
}

export async function stopZitadelKeyExpiryWorker(): Promise<void> {
  await zitadelKeyExpiryWorker.close();
}
