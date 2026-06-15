# Code Style — OpenWind Platform

Stack: TypeScript 5.5 · Hono · Drizzle ORM · Vitest · BullMQ · pnpm workspaces

---

## TypeScript

**No `any`.** Use `unknown` + type guard or `z.infer<>`. `any` in a PR blocks merge.

**Types derive from Zod schemas — never the reverse:**

```typescript
// Right
const CreateTicketSchema = z.object({ subject: z.string().min(1) });
type CreateTicketInput = z.infer<typeof CreateTicketSchema>;

// Wrong — type and schema can drift
type CreateTicketInput = { subject: string };
```

**Explicit return types on all exported functions.** Internal helpers may infer.

**No `process.env` reads in application code.** Always import from `@platform/config`.

**No type assertions without an inline comment** explaining why the type system can't infer it.

---

## Naming

| Thing                 | Convention              | Example                             |
| --------------------- | ----------------------- | ----------------------------------- |
| Files / directories   | `kebab-case`            | `workflow-engine.ts`                |
| Classes               | `PascalCase`            | `WorkflowEngine`                    |
| Interfaces / types    | `PascalCase`            | `EntityInstance`                    |
| Zod schemas           | `PascalCase` + `Schema` | `CreateTicketSchema`                |
| Functions             | `camelCase`             | `executeTransition()`               |
| Constants             | `SCREAMING_SNAKE_CASE`  | `MAX_FIELD_COUNT`                   |
| Env vars              | `SCREAMING_SNAKE_CASE`  | `DATABASE_URL`                      |
| DB tables / columns   | `snake_case`            | `entity_instances`, `current_state` |
| Drizzle table objects | `camelCase`             | `entityInstances`                   |
| Event types           | `dot.notation`          | `workflow.transitioned`             |
| tRPC procedures       | `camelCase`             | `ticket.create`                     |
| Packages              | `@platform/kebab-case`  | `@platform/entity-engine`           |
| Modules               | `@modules/kebab-case`   | `@modules/helpdesk`                 |

---

## API routes (Hono)

Every route uses `factory.createHandlers` with auth, role check, and validation:

```typescript
export const createFoo = factory.createHandlers(
  requireAuth(),
  requireRole("agent", "admin"),
  zValidator("json", CreateFooSchema),
  async (c) => {
    const input = c.req.valid("json");
    const { tenantId, userId } = c.get("auth");
    return c.json({ data: result }, 201);
  },
);
```

HTTP semantics: `201` create · `200` read/update · `204` delete · `400` bad input ·
`401` unauthenticated · `403` forbidden · `404` not found · `409` conflict ·
`422` validation error · `429` rate limited · `500` server error.

**Return 404, not 403, for cross-tenant resource access** — 403 leaks existence.

All responses use the envelope: `{ data: T }` on success, `{ error, message, fields? }` on error.

---

## Error handling

Every catch block either re-throws, logs + returns a typed error response, or logs + publishes `system.error` (in workers). Never swallow silently.

Use typed domain errors — not string messages:

```typescript
throw new WorkflowError("TRANSITION_FORBIDDEN", { instanceId, actorId });
```

The error handler in `apps/api/src/middleware/error-handler.ts` maps domain errors to HTTP. Add new error types there when you add new domain errors.

---

## Logging (pino — object FIRST, message SECOND)

```typescript
import { logger } from "@platform/logger";

logger.info({ tenantId, instanceId, durationMs }, "Transition executed");
logger.error({ tenantId, instanceId, error: err.code }, "Transition failed");
```

Every INFO-level log must include `tenantId` (in tenant-scoped operations) and relevant resource IDs. Never log passwords, tokens, API keys, or PII in plain text.

---

## Environment variables

Read exclusively from `@platform/config` — never `process.env` directly:

```typescript
import { env } from "@platform/config";
```

The app fails to start if any required variable is missing or malformed.

---

## Module layer

**Zero TypeScript in `modules/`.** Modules are INSERT statements only.

Config-first test (run mentally before every commit): did this require TypeScript changes
outside `packages/*` or `apps/*`? If yes — stop and ask if this is a missing engine feature.

---

## Comments

Default: none. Add only when the WHY is non-obvious: hidden constraint, subtle invariant,
specific bug workaround. Never describe what the code does.
