import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";
import { createApiKeyHandler } from "./create.js";
import { listApiKeysHandler } from "./list.js";
import { deleteApiKeyHandler } from "./delete.js";
import { rotateApiKeyHandler } from "./rotate.js";

const router = new Hono<{ Variables: { auth: AuthContext } }>();

router.post("/", ...createApiKeyHandler);
router.get("/", ...listApiKeysHandler);
router.delete("/:id", ...deleteApiKeyHandler);
router.post("/:id/rotate", ...rotateApiKeyHandler);

export { router as apiKeysRouter };
