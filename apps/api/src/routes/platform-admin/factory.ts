import { createFactory } from "hono/factory";
import type { PlatformAdminAuthContext } from "@platform/auth";

// Deliberately a separate Variables shape from dashboard/factory.ts's { auth: AuthContext }
// -- a handler built on this factory can only ever read `platformAdmin`, never `auth`, so a
// route under this tree cannot accidentally reuse tenant-scoped helpers that expect
// c.get("auth").tenantId (docs/specs/multi-org-sandbox.md R1/R2).
export const platformAdminFactory = createFactory<{
  Variables: { platformAdmin: PlatformAdminAuthContext };
}>();
