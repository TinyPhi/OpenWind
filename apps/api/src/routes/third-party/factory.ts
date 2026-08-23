import { createFactory } from "hono/factory";
import type { AuthContext, ActingPersonContext } from "@platform/auth";

// ADR-012 Phase B — every route in this folder sits behind both requireAuth()
// (the API key) and requireActingPerson() (the real person acting through
// it), so both are always present by the time a handler runs.
export const factory = createFactory<{
  Variables: { auth: AuthContext; actingPerson: ActingPersonContext };
}>();
