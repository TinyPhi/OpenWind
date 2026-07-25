import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";
import { getAuditLogHandler } from "./audit.js";
import { getSystemLogsHandler } from "./system-logs.js";
import {
  getViewConfigHandler,
  updateViewConfigHandler,
} from "./view-configs.js";
import {
  getPlatformSettingsHandler,
  updatePlatformSettingsHandler,
} from "./platform-settings.js";
import {
  listTenantsHandlers,
  createTenantHandlers,
  getTenantHandlers,
  suspendTenantHandlers,
  reactivateTenantHandlers,
  deleteTenantHandlers,
} from "./tenants.js";

const router = new Hono<{ Variables: { auth: AuthContext } }>();

router.get("/audit", ...getAuditLogHandler);
router.get("/system-logs", ...getSystemLogsHandler);
router.get("/view-configs/:entityType", ...getViewConfigHandler);
router.patch("/view-configs/:entityType", ...updateViewConfigHandler);
router.get("/platform-settings", ...getPlatformSettingsHandler);
router.patch("/platform-settings", ...updatePlatformSettingsHandler);

// Tenant lifecycle
router.get("/tenants", ...listTenantsHandlers);
router.post("/tenants", ...createTenantHandlers);
router.get("/tenants/:id", ...getTenantHandlers);
router.patch("/tenants/:id/suspend", ...suspendTenantHandlers);
router.patch("/tenants/:id/reactivate", ...reactivateTenantHandlers);
router.delete("/tenants/:id", ...deleteTenantHandlers);

export { router as adminRouter };
