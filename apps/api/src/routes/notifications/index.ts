import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";
import { listNotificationsHandler } from "./list.js";
import { markNotificationReadHandler } from "./mark-read.js";
import { markAllNotificationsReadHandler } from "./mark-all-read.js";

const notificationsRouter = new Hono<{ Variables: { auth: AuthContext } }>();

notificationsRouter.get("/", ...listNotificationsHandler);
notificationsRouter.post("/mark-all-read", ...markAllNotificationsReadHandler);
notificationsRouter.post("/:id/read", ...markNotificationReadHandler);

export { notificationsRouter };
