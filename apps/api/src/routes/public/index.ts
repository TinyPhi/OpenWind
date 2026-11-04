import { Hono } from "hono";
import { getOrgBrandingByKeyHandler } from "./org-branding.js";

const router = new Hono();

router.get("/org-branding/:key", ...getOrgBrandingByKeyHandler);

export { router as publicRouter };
