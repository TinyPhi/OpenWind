import { createFactory } from "hono/factory";

// No `auth` Variable — this route is deliberately unauthenticated (verified
// by HMAC signature instead, see handler.ts). Matches files/factory.ts's
// per-route-group factory pattern, minus the auth context this group never has.
export const factory = createFactory();
