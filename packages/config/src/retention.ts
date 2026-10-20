import { z } from "zod";
import { env } from "./env.js";

// The range a retention override may take. Defaults are the sweep's long-standing bounds; an
// operator can change them with RETENTION_*_MIN/MAX (validated in env.ts).
export const RETENTION_BOUNDS = {
  noiseDays: { min: env.RETENTION_DAYS_MIN, max: env.RETENTION_DAYS_MAX },
  commentDays: {
    min: env.RETENTION_COMMENT_DAYS_MIN,
    max: env.RETENTION_COMMENT_DAYS_MAX,
  },
  evidenceDays: {
    min: env.RETENTION_EVIDENCE_DAYS_MIN,
    max: env.RETENTION_EVIDENCE_DAYS_MAX,
  },
} as const;

export const retentionDays = (min: number, max: number): z.ZodNumber =>
  z.number().int().min(min).max(max);

export const TenantRetentionConfigSchema = z.object({
  retention_days: retentionDays(
    RETENTION_BOUNDS.noiseDays.min,
    RETENTION_BOUNDS.noiseDays.max,
  )
    .nullable()
    .optional(),
  retention_comment_days: retentionDays(
    RETENTION_BOUNDS.commentDays.min,
    RETENTION_BOUNDS.commentDays.max,
  )
    .nullable()
    .optional(),
  retention_evidence_days: retentionDays(
    RETENTION_BOUNDS.evidenceDays.min,
    RETENTION_BOUNDS.evidenceDays.max,
  )
    .nullable()
    .optional(),
  retention_hold: z.boolean().nullable().optional(),
});

export type TenantRetentionConfig = z.infer<typeof TenantRetentionConfigSchema>;

export const UpdateTenantRetentionSchema = TenantRetentionConfigSchema.extend({
  confirmShorten: z.boolean().optional(),
}).refine(
  (data) =>
    data.retention_days !== undefined ||
    data.retention_comment_days !== undefined ||
    data.retention_evidence_days !== undefined ||
    data.retention_hold !== undefined,
  {
    message: "At least one retention field must be provided to update",
  },
);

export type UpdateTenantRetentionInput = z.infer<
  typeof UpdateTenantRetentionSchema
>;

export interface RetentionPolicy {
  hold: boolean;
  noiseDays: number;
  commentDays: number;
  evidenceDays: number;
}

const SafeTenantRetentionConfigSchema = z.object({
  retention_days: retentionDays(
    RETENTION_BOUNDS.noiseDays.min,
    RETENTION_BOUNDS.noiseDays.max,
  )
    .nullable()
    .optional()
    .catch(undefined),
  retention_comment_days: retentionDays(
    RETENTION_BOUNDS.commentDays.min,
    RETENTION_BOUNDS.commentDays.max,
  )
    .nullable()
    .optional()
    .catch(undefined),
  retention_evidence_days: retentionDays(
    RETENTION_BOUNDS.evidenceDays.min,
    RETENTION_BOUNDS.evidenceDays.max,
  )
    .nullable()
    .optional()
    .catch(undefined),
  retention_hold: z.boolean().nullable().optional().catch(undefined),
});

// A malformed override falls back to the platform default for that field only;
// it must never widen deletion, so an unparseable hold is treated as a hold.
export function resolveRetentionPolicy(config: unknown): RetentionPolicy {
  const isObject =
    typeof config === "object" && config !== null && !Array.isArray(config);
  const raw = isObject ? (config as Record<string, unknown>) : {};
  const parsed = SafeTenantRetentionConfigSchema.parse(raw);
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
