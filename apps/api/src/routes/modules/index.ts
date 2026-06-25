import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthContext } from "@platform/auth";
import { requireAuth, requireRole } from "@platform/auth";
import { db } from "@platform/db";
import { logger } from "@platform/logger";
import { ModuleService } from "../../services/module-service.js";

type Vars = { Variables: { auth: AuthContext } };

const router = new Hono<Vars>();

const SlugParamSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, "Invalid module slug"),
});

const InstallBodySchema = z.object({
  workflowName: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9 _-]+$/, "Invalid workflow name")
    .optional(),
});

// Require authentication for all module routes
router.use("*", requireAuth(db));

// List modules status for the current tenant
router.get("/", async (c) => {
  const auth = c.get("auth");
  try {
    const list = await ModuleService.listModules(auth.tenantId);
    return c.json({ data: list });
  } catch (err: unknown) {
    logger.error({ err, tenantId: auth.tenantId }, "listModules failed");
    return c.json(
      { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
      500,
    );
  }
});

// Install a module (admin only)
router.post(
  "/:slug/install",
  requireRole("admin"),
  zValidator("param", SlugParamSchema),
  zValidator("json", InstallBodySchema),
  async (c) => {
    const auth = c.get("auth");
    const { slug } = c.req.valid("param");
    const { workflowName } = c.req.valid("json");

    try {
      await ModuleService.installModule(
        auth.tenantId,
        slug,
        workflowName !== undefined ? { workflowName } : {},
      );
      return c.json({ data: { slug, status: "installed" } }, 201);
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, slug },
        "installModule failed",
      );
      return c.json(
        { error: "INSTALL_FAILED", message: "Failed to install module" },
        500,
      );
    }
  },
);

// Uninstall a module (admin only)
router.post(
  "/:slug/uninstall",
  requireRole("admin"),
  zValidator("param", SlugParamSchema),
  async (c) => {
    const auth = c.get("auth");
    const { slug } = c.req.valid("param");

    try {
      await ModuleService.uninstallModule(auth.tenantId, slug);
      return c.json({ data: { slug, status: "uninstalled" } });
    } catch (err: unknown) {
      logger.error(
        { err, tenantId: auth.tenantId, slug },
        "uninstallModule failed",
      );
      return c.json(
        { error: "UNINSTALL_FAILED", message: "Failed to uninstall module" },
        500,
      );
    }
  },
);

// Seed the module registry (admin only) — idempotent, safe to call multiple times
router.post("/seed", requireAuth(db), requireRole("admin"), async (c) => {
  const auth = c.get("auth");
  try {
    await ModuleService.seedRegistry();
    const list = await ModuleService.listModules(auth.tenantId);
    return c.json({ data: { seeded: list.length } }, 201);
  } catch (err: unknown) {
    logger.error({ err }, "seedRegistry failed");
    return c.json(
      { error: "SEED_FAILED", message: "Failed to seed module registry" },
      500,
    );
  }
});

export { router as modulesRouter };
