import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";
import { env } from "@platform/config";
import { logger } from "@platform/logger";
import { requireAuth, requireRole } from "@platform/auth";
import type { AuthContext } from "@platform/auth";
import { correlationId } from "./middleware/correlation-id.js";
import { handleError } from "./middleware/error-handler.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { httpsEnforcement } from "./middleware/https-enforcement.js";
import { entityTypesRouter } from "./routes/entity-types/index.js";
import { entitiesRouter } from "./routes/entities/index.js";
import { workflowsRouter } from "./routes/workflows/index.js";
import { automationRulesRouter } from "./routes/automation-rules/index.js";
import { apiKeysRouter } from "./routes/api-keys/index.js";
import { modulesRouter } from "./routes/modules/index.js";
import { pluginsRouter } from "./routes/plugins/index.js";
import { viewConfigsRouter } from "./routes/view-configs/index.js";
import { rolesRouter } from "./routes/platform/roles.js";
import { usersRouter } from "./routes/platform/users.js";
import { filesRouter } from "./routes/files/index.js";
import { adminRouter } from "./routes/admin/index.js";
import { preferencesRouter } from "./routes/preferences/index.js";
import { savedViewsRouter } from "./routes/saved-views/index.js";
import { notificationsRouter } from "./routes/notifications/index.js";
import { exportsRouter } from "./routes/exports/download.js";
import { dashboardRouter } from "./routes/dashboard/index.js";
import { webhooksRouter } from "./routes/webhooks/index.js";
import { connectorsRouter } from "./routes/connectors/index.js";
import { thirdPartyRouter } from "./routes/third-party/index.js";
import { openApiSpec } from "./openapi.js";
import { registerEntityAuditHook } from "@platform/entity-engine";
import { writeAuditEntry } from "@platform/audit";

// ── PII-aware entity audit hook ───────────────────────────────────────────────
// Registered once at module load so it is active for every entity mutation.
// The hook receives the same db/tx as the mutation — audit is in the same
// connection and, when the caller uses withTenantContext, the same transaction.
registerEntityAuditHook(async (p) => {
  await writeAuditEntry(p.db, {
    tenantId: p.tenantId,
    actorId: p.actorId,
    actorType: p.actorType,
    actingPersonId: p.actingPersonId,
    resourceType: p.resourceType,
    resourceId: p.resourceId,
    action: p.action,
    beforeSnapshot: p.beforeSnapshot,
    afterSnapshot: p.afterSnapshot,
    entityFields: p.entityFields,
  });
});

type AppVars = { Variables: { auth: AuthContext; requestId: string } };

export function createApp(): Hono<AppVars> {
  const app = new Hono<AppVars>();

  // ADR-012 Phase G, spec R6 — a startup sanity warning, not a hard failure:
  if (env.JWT_MAX_TOKEN_AGE_SECONDS > 30 * 60) {
    logger.warn(
      { jwtMaxTokenAgeSeconds: env.JWT_MAX_TOKEN_AGE_SECONDS },
      "JWT_MAX_TOKEN_AGE_SECONDS is set to a value (>30min) that weakens the third-party acting-person token-freshness check",
    );
  }

  // Middleware order matters:
  // 1. CORS — before everything else so preflight OPTIONS requests are handled immediately
  const ALLOWED_ORIGINS =
    env.NODE_ENV === "production"
      ? [env.CORS_ORIGIN ?? ""].filter(Boolean)
      : null; // null = use the localhost-wildcard logic below in dev/test

  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (
          env.NODE_ENV !== "production" &&
          origin.startsWith("http://localhost:")
        ) {
          return origin;
        }
        if (ALLOWED_ORIGINS?.includes(origin)) {
          return origin;
        }
        return ALLOWED_ORIGINS?.[0] ?? "http://localhost:3001";
      },
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "X-Correlation-ID"],
      exposeHeaders: ["X-Correlation-ID"],
      credentials: true,
    }),
  );

  // 3. Correlation ID — must be early so all downstream logs carry the request ID
  app.use("*", correlationId());

  app.use("*", httpsEnforcement());
  // 4. Hono request logger
  app.use("*", honoLogger());
  // 5. Rate limiter — before auth so unauthenticated flood is blocked cheaply
  app.use("*", rateLimit());
  // 6. Error handler — app.onError is the correct Hono v4 API for route errors
  app.onError(handleError);

  app.get("/health", (c) => c.json({ status: "ok" }));

  // OpenAPI spec — unauthenticated, served from generated static object
  app.get("/openapi.json", (c) => c.json(openApiSpec));

  // Temporary debug route — shows the parsed auth context for the current token.
  // Restricted to superadmin to prevent any authenticated user from probing their own context.
  if (env.NODE_ENV !== "production") {
    app.get("/auth/debug", requireAuth(), requireRole("superadmin"), (c) => {
      const auth = c.get("auth");
      return c.json({ data: auth });
    });
  }

  app.route("/entity-types", entityTypesRouter);
  app.route("/entities", entitiesRouter);
  app.route("/workflows", workflowsRouter);
  app.route("/automation-rules", automationRulesRouter);
  app.route("/api-keys", apiKeysRouter);
  app.route("/modules", modulesRouter);
  app.route("/plugins", pluginsRouter);
  app.route("/admin/view-configs", viewConfigsRouter);
  app.route("/roles", rolesRouter);
  app.route("/users", usersRouter);
  app.route("/files", filesRouter);
  app.route("/admin", adminRouter);
  app.route("/preferences", preferencesRouter);
  app.route("/saved-views", savedViewsRouter);
  app.route("/notifications", notificationsRouter);
  app.route("/exports", exportsRouter);
  app.route("/dashboard", dashboardRouter);
  app.route("/connectors", connectorsRouter);
  // ADR-012 Phase B — third-party ticket-lifecycle API, versioned separately
  // from every other route above since it's a public/partner-facing surface
  // (ADR-010) rather than the admin-ui's own internal API.
  app.route("/api/v1", thirdPartyRouter);
  // Unauthenticated by design — HMAC-verified inside the handler, per
  // ADR-009 Decision #3. AC2's pre-auth, IP-keyed flood guard is already
  // satisfied by the global rateLimit() middleware applied above (step 4) —
  // no separate route-level guard needed for this route specifically.
  app.route("/webhooks", webhooksRouter);

  return app;
}
