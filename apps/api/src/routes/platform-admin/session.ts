import { requirePlatformAdmin } from "@platform/auth";
import { platformAdminFactory } from "./factory.js";

/**
 * T3 (docs/specs/multi-org-sandbox.md Phase 1): proves the `/platform-admin` route tree is
 * reachable end-to-end (TOTP MFA + role claim, no tenant-resolution) before any sandbox data
 * exists to serve. Deliberately returns only identity fields -- no sandbox list here, that's
 * T17's dashboard route, built on withPlatformAdminContext + toPlatformAdminSandboxView once
 * Phase 2 provisioning exists.
 */
export const sessionHandler = platformAdminFactory.createHandlers(
  requirePlatformAdmin(),
  (c) => {
    const { userId, displayName, email } = c.get("platformAdmin");
    return c.json({ data: { userId, displayName, email } });
  },
);
