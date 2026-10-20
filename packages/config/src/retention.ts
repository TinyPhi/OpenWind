import { z } from "zod";
import { env } from "./env.js";

// One definition of a valid tenant retention override, shared by provisioning, the PATCH route
// and the sweep (the worker cannot import from apps/api). Bounds come from validated env.
const days = (min: number, max: number): z.ZodNumber =>
  z.number().int().min(min).max(max);

export const RETENTION_DAY_FIELDS = [
  "retention_days",
  "retention_comment_days",
  "retention_evidence_days",
] as const;

export type RetentionDayField = (typeof RETENTION_DAY_FIELDS)[number];

export const RETENTION_BOUNDS: Record<
  RetentionDayField,
  { min: number; max: number }
> = {
  retention_days: { min: env.RETENTION_DAYS_MIN, max: env.RETENTION_DAYS_MAX },
  retention_comment_days: {
    min: env.RETENTION_COMMENT_DAYS_MIN,
    max: env.RETENTION_COMMENT_DAYS_MAX,
  },
  retention_evidence_days: {
    min: env.RETENTION_EVIDENCE_DAYS_MIN,
    max: env.RETENTION_EVIDENCE_DAYS_MAX,
  },
};

const dayField = (f: RetentionDayField): z.ZodNumber =>
  days(RETENTION_BOUNDS[f].min, RETENTION_BOUNDS[f].max);

export const RetentionFieldsSchema = z.object({
  retention_days: dayField("retention_days").optional(),
  retention_comment_days: dayField("retention_comment_days").optional(),
  retention_evidence_days: dayField("retention_evidence_days").optional(),
  retention_hold: z.boolean().optional(),
});

export type RetentionFields = z.infer<typeof RetentionFieldsSchema>;

// PATCH body: null clears a key (back to the platform default, or no hold).
export const RetentionPatchSchema = z
  .object({
    retention_days: dayField("retention_days").nullable().optional(),
    retention_comment_days: dayField("retention_comment_days")
      .nullable()
      .optional(),
    retention_evidence_days: dayField("retention_evidence_days")
      .nullable()
      .optional(),
    retention_hold: z.boolean().nullable().optional(),
    confirmShorten: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.retention_days !== undefined ||
      v.retention_comment_days !== undefined ||
      v.retention_evidence_days !== undefined ||
      v.retention_hold !== undefined,
    { message: "at least one retention field is required" },
  );

export type RetentionPatch = z.infer<typeof RetentionPatchSchema>;
