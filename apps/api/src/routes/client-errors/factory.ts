import { createFactory } from "hono/factory";
import type { AuthContext } from "@platform/auth";

export const factory = createFactory<{ Variables: { auth: AuthContext } }>();
