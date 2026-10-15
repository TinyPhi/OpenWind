import { z } from "zod";
import { env } from "@platform/config";

export interface RetentionPolicy {
  hold: boolean;
  noiseDays: number;
  commentDays: number;
  evidenceDays: number;
}

const days = (min: number, max: number): z.ZodNumber =>
  z.number().int().min(min).max(max);

const TenantRetentionConfigSchema = z.object({
  retention_days: days(7, 3650).optional().catch(undefined),
  retention_comment_days: days(30, 3650).optional().catch(undefined),
  retention_evidence_days: days(365, 7300).optional().catch(undefined),
  retention_hold: z.boolean().optional().catch(undefined),
});

// A malformed override falls back to the platform default for that field only;
// it must never widen deletion, so an unparseable hold is treated as a hold.
export function resolveRetentionPolicy(config: unknown): RetentionPolicy {
  const isObject =
    typeof config === "object" && config !== null && !Array.isArray(config);
  const raw = isObject ? (config as Record<string, unknown>) : {};
  const parsed = TenantRetentionConfigSchema.parse(raw);
  const holdRaw = raw["retention_hold"];
  const unparseableHold =
    holdRaw !== undefined && typeof holdRaw !== "boolean" && holdRaw !== null;
  return {
    hold:
      parsed.retention_hold === true ||
      unparseableHold ||
      (config !== null && config !== undefined && !isObject),
    noiseDays: parsed.retention_days ?? env.RETENTION_DEFAULT_DAYS,
    commentDays: parsed.retention_comment_days ?? env.RETENTION_COMMENT_DAYS,
    evidenceDays: parsed.retention_evidence_days ?? env.RETENTION_EVIDENCE_DAYS,
  };
}
