import { Hono } from "hono";
import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import type { AuthContext } from "@platform/auth";
import { requireAuth, requireRole } from "@platform/auth";
import { db } from "@platform/db";
import { logger } from "@platform/logger";
import {
  installPlugin,
  uninstallPlugin,
  listPluginsForTenant,
  reportPluginRuntimeError,
  PluginLifecycleError,
  PLUGIN_LIFECYCLE_ERROR_STATUS,
} from "../../services/plugin-lifecycle.js";

type Vars = { Variables: { auth: AuthContext } };

const router = new Hono<Vars>();

const SlugParamSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/, "Invalid plugin slug"),
});

// manifest is intentionally z.unknown() here — installPlugin validates it
// against PluginManifestSchema itself and reports structured issues in
// INVALID_MANIFEST, rather than this route duplicating that schema.
const InstallBodySchema = z.object({
  manifest: z.unknown(),
  migrationSql: z.string(),
});

const UninstallBodySchema = z.object({
  retainData: z.boolean().optional(),
});

const ReportErrorBodySchema = z.object({
  slotName: z.string().max(200).optional(),
  message: z.string().max(2000),
  componentStack: z.string().max(4000).optional(),
});

// Require authentication for all plugin routes.
router.use("*", requireAuth(db));

// List every catalog plugin, annotated with this tenant's install status
// (R11's health dashboard — generic list view, not a bespoke per-plugin query).
// Review finding (PR #397, PrabhuVijit, N1): spec task T6 requires
// requireRole("admin") on all three plugin admin routes; this one was
// missing it, letting any authenticated user see install status/error counts.
router.get("/", requireRole("admin"), async (c) => {
  const auth = c.get("auth");
  try {
    const list = await listPluginsForTenant(auth.tenantId);
    return c.json({ data: list });
  } catch (err: unknown) {
    logger.error(
      { err, tenantId: auth.tenantId },
      "listPluginsForTenant failed",
    );
    return c.json(
      { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
      500,
    );
  }
});

// Install a plugin for the caller's own tenant (admin only). No filesystem/
// registry convention exists yet for resolving a plugin's manifest/migration
// bundle from its slug alone (that's #368/marketplace-adjacent work) — the
// caller supplies both explicitly for now.
router.post(
  "/:slug/install",
  requireRole("admin"),
  zValidator("param", SlugParamSchema),
  zValidator("json", InstallBodySchema),
  async (c) => {
    const auth = c.get("auth");
    const { slug } = c.req.valid("param");
    const { manifest, migrationSql } = c.req.valid("json");

    try {
      const result = await installPlugin(auth.tenantId, slug, {
        manifest,
        migrationSql,
      });
      return c.json({ data: { slug, ...result } }, 201);
    } catch (err: unknown) {
      if (err instanceof PluginLifecycleError) {
        return c.json(
          { error: err.code, message: err.message, fields: err.meta },
          PLUGIN_LIFECYCLE_ERROR_STATUS[err.code] as 400,
        );
      }
      logger.error(
        { err, tenantId: auth.tenantId, slug },
        "installPlugin failed",
      );
      return c.json(
        { error: "INSTALL_FAILED", message: "Failed to install plugin" },
        500,
      );
    }
  },
);

// Uninstall a plugin for the caller's own tenant (admin only).
router.post(
  "/:slug/uninstall",
  requireRole("admin"),
  zValidator("param", SlugParamSchema),
  zValidator("json", UninstallBodySchema),
  async (c) => {
    const auth = c.get("auth");
    const { slug } = c.req.valid("param");
    const { retainData } = c.req.valid("json");

    try {
      await uninstallPlugin(
        auth.tenantId,
        slug,
        retainData !== undefined ? { retainData } : {},
      );
      return c.json({ data: { slug, status: "disabled" } });
    } catch (err: unknown) {
      if (err instanceof PluginLifecycleError) {
        return c.json(
          { error: err.code, message: err.message, fields: err.meta },
          PLUGIN_LIFECYCLE_ERROR_STATUS[err.code] as 400,
        );
      }
      logger.error(
        { err, tenantId: auth.tenantId, slug },
        "uninstallPlugin failed",
      );
      return c.json(
        { error: "UNINSTALL_FAILED", message: "Failed to uninstall plugin" },
        500,
      );
    }
  },
);

// Client-side plugin failure reporting (R7 — a <PluginSlot> error boundary
// catching a plugin UI exception). Any authenticated user can report — this
// is telemetry, not a mutation of anything the caller owns, so no role check
// beyond requireAuth (already applied to the whole router above).
router.post(
  "/:slug/errors",
  zValidator("param", SlugParamSchema),
  zValidator("json", ReportErrorBodySchema),
  async (c) => {
    const auth = c.get("auth");
    const { slug } = c.req.valid("param");
    const { slotName, message, componentStack } = c.req.valid("json");

    try {
      await reportPluginRuntimeError(auth.tenantId, slug, {
        slotName,
        message,
        componentStack,
      });
      return c.json({ data: { reported: true } }, 201);
    } catch (err: unknown) {
      if (err instanceof PluginLifecycleError) {
        return c.json(
          { error: err.code, message: err.message },
          PLUGIN_LIFECYCLE_ERROR_STATUS[err.code] as 400,
        );
      }
      logger.error(
        { err, tenantId: auth.tenantId, slug },
        "reportPluginRuntimeError failed",
      );
      return c.json(
        { error: "REPORT_FAILED", message: "Failed to report plugin error" },
        500,
      );
    }
  },
);

export { router as pluginsRouter };
