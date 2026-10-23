import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";
import { myViewHandler } from "./my-view.js";
import { orgViewHandler } from "./org-view.js";
import { teamMemberViewHandler } from "./team-member-view.js";

const router = new Hono<{ Variables: { auth: AuthContext } }>();

router.get("/my-view", ...myViewHandler);
// My Org View (docs/specs/my-org-view.md).
router.get("/org-view", ...orgViewHandler);
// "View as subordinate" (docs/specs/my-org-view.md R9).
router.get("/team-member-view/:userId", ...teamMemberViewHandler);

export { router as dashboardRouter };
