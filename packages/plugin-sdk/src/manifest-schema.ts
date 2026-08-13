import { z } from "zod";

/**
 * Structural validation of a PluginManifest object (types.ts's interface has no
 * runtime enforcement of its own — this is that enforcement, per this repo's
 * "types derive from Zod, never the reverse" rule applied to plugin manifests too).
 * Mirrors PluginManifest/PluginPermission/SlotRegistration/PageRegistration exactly;
 * keep both in sync by hand — see types.ts's own comment if this drifts.
 */

const PluginPermissionSchema = z.union([
  z.custom<`db:${string}`>((v) => typeof v === "string" && v.startsWith("db:")),
  z.custom<`events:${string}`>(
    (v) => typeof v === "string" && v.startsWith("events:"),
  ),
  z.custom<`slots:${string}`>(
    (v) => typeof v === "string" && v.startsWith("slots:"),
  ),
  z.custom<`api:${string}`>(
    (v) => typeof v === "string" && v.startsWith("api:"),
  ),
  z.literal("ai:inference"),
  z.literal("files:read"),
  z.literal("files:write"),
]);

const SlotRegistrationSchema = z.object({
  name: z.string().min(1),
  component: z.string().min(1),
  priority: z.number().optional(),
  context: z.array(z.string()).optional(),
});

const PageRegistrationSchema = z.object({
  path: z.string().min(1),
  component: z.string().min(1),
  title: z.string().min(1),
  icon: z.string().optional(),
});

export const PluginManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  platformVersion: z.string().min(1),
  description: z.string().optional(),
  authorUrl: z.string().optional(),
  requires: z.array(z.string()).optional(),
  permissions: z.array(PluginPermissionSchema),
  migrations: z.string().optional(),
  routes: z.string().optional(),
  hooks: z.string().optional(),
  jobs: z.string().optional(),
  ui: z
    .object({
      remote: z.string().min(1),
      slots: z.array(SlotRegistrationSchema).optional(),
      pages: z.array(PageRegistrationSchema).optional(),
    })
    .optional(),
  onActivate: z.string().optional(),
  onDeactivate: z.string().optional(),
});

export type ValidatedPluginManifest = z.infer<typeof PluginManifestSchema>;
