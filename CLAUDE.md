# CLAUDE.md — Platform Engineering Context

This file is loaded automatically by Claude Code at the start of every session.
It is the single source of truth for how this codebase is structured, what
conventions apply, and what decisions have already been made. Read it fully
before writing any code.

---

## What we are building

A modular, workflow-native business platform. Customers install modules (CRM,
helpdesk, HRMS, reimbursements, procurement, etc.) that are all configurations
of three shared engines: an Entity Engine, a Workflow Engine, and an Automation
Engine. Every "object" in the system is an entity instance. Every process is a
state machine. Every side effect is an automation rule.

Reference documents (read these for deep context before working on a new area):

- `docs/architecture-brief.md` — full platform architecture
- `docs/decisions/ADR-001-multitenancy.md` — tenancy model
- `docs/decisions/ADR-002-workflow-engine.md` — state machine design
- `docs/decisions/ADR-003-field-validation.md` — entity validation

**`docs/` is the single home for all project documentation.** `docs/sup-docs/` contains
supporting material for development, maintenance, and project tracking:

- `docs/sup-docs/roadmap-tracker.md` — big-ticket feature table, % complete per track, all phases
- `docs/sup-docs/week-log.md` — running WoW velocity log (update each session)
- `docs/sup-docs/phase-timeline.md` — projected schedule and AI-first team operating model
- `docs/sup-docs/analysis-YYYY-MM-DD.md` — frozen session snapshots

---

## Repository layout

```
platform/
├── apps/
│   ├── api/          # Main Hono API server (Node.js)
│   ├── worker/       # BullMQ background workers
│   ├── admin-ui/     # Refine + shadcn/ui admin application
│   └── portal/       # Customer-facing portal (React)
├── packages/
│   ├── db/           # Drizzle schema, migrations, client
│   ├── entity-engine/
│   ├── workflow-engine/
│   ├── automation-engine/
│   ├── connector-sdk/
│   ├── plugin-sdk/
│   ├── ui/           # Shared design system (shadcn/ui + tokens)
│   ├── auth/         # Zitadel JWT middleware + RBAC helpers
│   ├── notifications/ # Novu wrapper
│   ├── files/        # S3/MinIO presigned URL service
│   ├── audit/        # Append-only audit log
│   ├── ai/           # Anthropic SDK wrapper + RAG
│   └── tsconfig/     # Shared TypeScript configs
└── modules/
    ├── crm/
    ├── helpdesk/
    ├── hrms/
    ├── reimbursements/
    ├── projects/
    ├── invoicing/
    └── procurement/
```

---

## The dependency rule — enforced at build time

Dependencies flow strictly **downward**. This is enforced by ESLint import
rules and will cause CI failures if violated.

```
apps/* → packages/* → (no upward imports)
modules/* → packages/* → (no imports from other modules/*)
packages/entity-engine → packages/db only
packages/workflow-engine → packages/db, packages/entity-engine
packages/automation-engine → packages/db, packages/workflow-engine, packages/entity-engine
```

**Forbidden patterns — these are build errors:**

- `modules/crm` importing from `modules/helpdesk`
- `packages/entity-engine` importing from `packages/workflow-engine`
- Any `packages/*` importing from `apps/*` or `modules/*`
- Cross-module imports of any kind

Cross-module communication happens exclusively through:

1. The event bus (publish/subscribe via `packages/automation-engine`)
2. The entity engine's relation API (foreign key lookups between entity types)
3. tRPC procedures exposed by `apps/api`

---

## TypeScript conventions

**Strict mode everywhere — no exceptions.**

Every `tsconfig.json` extends `@platform/tsconfig/base.json` which sets:

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "noImplicitReturns": true,
  "exactOptionalPropertyTypes": true
}
```

**No `any`.** If you find yourself reaching for `any`, use `unknown` and narrow
it with a type guard or Zod parse. `any` in a PR blocks merge.

**No type assertions without justification.** `value as SomeType` requires an
inline comment explaining why the type system cannot infer this:

```typescript
// The schema guarantees this is a string after validation — Zod output is typed
// as Record<string,unknown> because the schema is dynamic
const subject = fields.subject as string;
```

**Zod is the type authority at all external boundaries.** Every API input,
every event payload, every config file, every database result that crosses a
module boundary is validated by a Zod schema. TypeScript types are derived from
Zod schemas using `z.infer<>`, never written separately:

```typescript
// Correct
const CreateTicketSchema = z.object({ subject: z.string().min(1) });
type CreateTicketInput = z.infer<typeof CreateTicketSchema>;

// Wrong — type and schema can drift
type CreateTicketInput = { subject: string };
const CreateTicketSchema = z.object({ subject: z.string().min(1) });
```

**Explicit return types on all exported functions.** Internal helpers can infer.
Public API of any package must have explicit return types.

---

## Naming conventions

| Thing                 | Convention                     | Example                   |
| --------------------- | ------------------------------ | ------------------------- |
| Files                 | `kebab-case`                   | `workflow-engine.ts`      |
| Directories           | `kebab-case`                   | `entity-engine/`          |
| Classes               | `PascalCase`                   | `WorkflowEngine`          |
| Interfaces / types    | `PascalCase`                   | `EntityInstance`          |
| Zod schemas           | `PascalCase` + `Schema` suffix | `CreateTicketSchema`      |
| Functions             | `camelCase`                    | `executeTransition()`     |
| Constants             | `SCREAMING_SNAKE_CASE`         | `MAX_FIELD_COUNT`         |
| Env vars              | `SCREAMING_SNAKE_CASE`         | `DATABASE_URL`            |
| Database tables       | `snake_case`                   | `entity_instances`        |
| Database columns      | `snake_case`                   | `current_state`           |
| Drizzle table objects | `camelCase`                    | `entityInstances`         |
| Event types           | `dot.notation`                 | `workflow.transitioned`   |
| tRPC procedures       | `camelCase`                    | `ticket.create`           |
| Package names         | `@platform/kebab-case`         | `@platform/entity-engine` |
| Module names          | `@modules/kebab-case`          | `@modules/helpdesk`       |

---

## Database conventions

**Every tenant-scoped table must have:**

```sql
tenant_id UUID NOT NULL
-- + RLS policy (see ADR-001)
-- + tenant_id index
-- + composite index for primary query pattern
```

**No raw SQL in application code** except:

1. Migration files in `packages/db/migrations/`
2. Explicitly performance-critical hot paths with a comment explaining why
   Drizzle was insufficient

**All queries go through Drizzle.** The `db` instance is never used outside of
`packages/db/` and the packages/apps that import it directly. Never instantiate
a new database client in a module — import from `@platform/db`.

**Migration files are numbered SQL files, not Drizzle push:**

```
packages/db/migrations/
  0001_initial_schema.sql
  0002_add_workflow_events.sql
  0003_automation_engine.sql
```

Each migration runs in a transaction. Partial migrations are a production
incident. Every migration PR must include:

- [ ] `tenant_id NOT NULL` on all new tenant-scoped tables
- [ ] RLS policy for each new table
- [ ] Indexes for `tenant_id` and primary query patterns
- [ ] Down migration (rollback SQL) as a comment block at the top of the file

**Connection management:** Never open a direct database connection. Always use
`@platform/db` which manages the pool. The tenant context middleware sets
`app.tenant_id` via `set_config` — this is the RLS enforcement mechanism.

---

## API conventions (Hono)

**All API routes live in `apps/api/src/routes/`**, organized by domain:

```
routes/
  entities/
    index.ts        # Router definition
    create.ts       # POST /entities/:typeId
    update.ts       # PATCH /entities/:id
    transition.ts   # POST /entities/:id/transitions
  workflows/
  automations/
  ...
```

**Every route handler follows this pattern:**

```typescript
import { zValidator } from "@hono/zod-validator";
import { requireAuth } from "@platform/auth";
import { CreateTicketSchema } from "@modules/helpdesk/schemas";

export const createTicket = factory.createHandlers(
  requireAuth(),
  requireRole("agent", "admin"),
  zValidator("json", CreateTicketSchema),
  async (c) => {
    const input = c.req.valid("json"); // typed, validated
    const { tenantId, userId } = c.get("auth");

    // business logic here

    return c.json(result, 201);
  },
);
```

**HTTP status codes are semantic:**

- `200` — successful GET/PATCH
- `201` — successful POST (created)
- `204` — successful DELETE (no body)
- `400` — malformed request (bad JSON, missing required params)
- `401` — not authenticated
- `403` — authenticated but not authorized
- `404` — resource not found (or not visible to this tenant — same response)
- `409` — conflict (e.g., concurrent transition attempt)
- `422` — validation error (returns `ValidationError` format — see ADR-003)
- `429` — rate limited
- `500` — unexpected server error (never expose internal details)

**Never return 404 vs 403 differences for tenant-isolated resources.** If Tenant
A requests an entity that belongs to Tenant B, return 404, not 403. Returning
403 leaks the existence of the resource.

**All errors follow this envelope:**

```typescript
// Success
{ data: T }

// Error
{ error: string; message: string; fields?: FieldError[] }
```

---

## Error handling

**Never swallow errors silently.** Every catch block either:

1. Re-throws (if the caller should handle it)
2. Logs + returns a typed error response (at the API boundary)
3. Logs + publishes a `system.error` event (in background workers)

**Use typed domain errors, not string messages:**

```typescript
// packages/workflow-engine/src/errors.ts
export class WorkflowError extends Error {
  constructor(
    public readonly code: WorkflowErrorCode,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "WorkflowError";
  }
}

export type WorkflowErrorCode =
  | "INSTANCE_NOT_FOUND"
  | "TRANSITION_NOT_AVAILABLE"
  | "TRANSITION_FORBIDDEN"
  | "CONDITION_NOT_MET"
  | "REQUIRED_FIELDS_MISSING"
  | "SLA_TIMER_FAILED";
```

**The API error handler** in `apps/api/src/middleware/error-handler.ts` maps
domain errors to HTTP responses. Add new error types there when you add new
domain errors.

---

## Testing conventions

**Every PR that adds or changes behavior must include tests.** CI blocks merge
if coverage drops below baseline.

**Test file colocation:**

```
packages/workflow-engine/src/
  engine.ts
  engine.test.ts       # unit tests alongside source
tests/
  integration/         # cross-package integration tests
  isolation/           # tenant RLS isolation tests (run on every db/ PR)
  e2e/                 # full API end-to-end tests
```

**Test naming:**

```typescript
describe('executeTransition', () => {
  it('transitions entity to new state when all guards pass', async () => { ... });
  it('throws TRANSITION_FORBIDDEN when actor lacks required role', async () => { ... });
  it('throws CONDITION_NOT_MET when condition evaluates false', async () => { ... });
  it('writes immutable event log entry on successful transition', async () => { ... });
  it('rolls back all writes if outbox insert fails', async () => { ... });
});
```

Descriptions are complete sentences. They describe behavior, not implementation.
"transitions entity to new state" not "calls db.update".

**Test database:** Each test suite gets a fresh schema via `packages/db/test-utils`
which creates a test tenant, runs all migrations, and tears down after the suite.
Tests never share state. Tests never hit external services — all external calls
are mocked at the service boundary.

**The tenant isolation test suite** (`tests/isolation/`) is mandatory reading
before touching any database code. It attempts cross-tenant data access via
every public API surface. Adding a new route or table? Add isolation tests for
it in the same PR.

---

## Environment variables

All environment variables are defined and validated in `packages/config/src/env.ts`
using Zod. The application fails to start if any required variable is missing
or malformed. **Never read `process.env` directly in application code** — import
from `@platform/config`.

```typescript
// packages/config/src/env.ts
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MIN: z.coerce.number().int().min(1).default(2),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
  REDIS_URL: z.string().url(),
  ZITADEL_ISSUER: z.string().url(),
  ZITADEL_AUDIENCE: z.string(),
  NOVU_API_KEY: z.string(),
  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string(),
  S3_ACCESS_KEY: z.string(),
  S3_SECRET_KEY: z.string(),
  ANTHROPIC_API_KEY: z.string(),
  // OpenBao (replaces ENCRYPTION_KEY — see Phase 1 / 1A)
  OPENBAO_ADDR: z.string().url(),
  OPENBAO_ROLE_ID: z.string(),
  OPENBAO_SECRET_ID: z.string(),
  OPENBAO_TRANSIT_KEY: z.string(),
});

export const env = EnvSchema.parse(process.env);
export type Env = z.infer<typeof EnvSchema>;
```

---

## Logging

**Use structured logging everywhere.** Never `console.log`. Use the shared
logger from `@platform/logger` which outputs JSON in production and pretty
output in development.

```typescript
import { logger } from "@platform/logger";

// pino signature: logger.level(mergingObject, message) — object FIRST, message SECOND
logger.info(
  { instanceId, fromState, toState, actorId, durationMs },
  "Transition executed",
);

logger.error(
  { instanceId, error: err.code, meta: err.meta },
  "Transition failed",
);
```

**Every log entry at INFO level or above must include:**

- `tenantId` (if in a tenant-scoped operation)
- Relevant entity/resource IDs
- Operation name or context

**Never log:**

- Passwords, tokens, API keys, or secrets (ever)
- Full request/response bodies in production (use sampling)
- PII in plain text (mask or hash)

---

## Security rules

These are non-negotiable and reviewed in every PR:

1. **RLS is not optional.** Every new table that stores tenant data must have
   RLS enabled and a policy defined. PRs missing this are blocked.

2. **Validate all external input with Zod before using it.** API inputs, webhook
   payloads, connector data, file metadata — all validated before processing.

3. **Never construct SQL strings from user input.** Always use Drizzle's
   parameterized queries or `sql` tagged template literals. The linter flags
   string concatenation in SQL contexts.

4. **Presigned URLs only for file access.** The S3 bucket is never publicly
   accessible. All file access is through the platform's files service which
   validates tenant ownership before signing.

5. **Never expose internal error details to clients.** Catch all unhandled
   errors at the API boundary and return a generic 500. Log the full error
   server-side with a correlation ID that the client receives.

6. **Rate limit all public endpoints.** Default: 100 req/min per tenant for
   standard endpoints, 10 req/min for auth and webhook endpoints. Override
   in route definition with explicit justification in the PR.

7. **All secrets in environment variables.** No hardcoded credentials, tokens,
   or keys anywhere in the codebase — including tests.

---

## AI development conventions (Claude Code)

This codebase is developed with an AI-first team model. Claude Code handles implementation;
humans drive architecture decisions, security reviews, and product judgment.

### Session workflow (every feature track)

1. **Spec** — run `/spec` to write a spec for the track. Reference the relevant ADR, the
   engine it touches, and the data flow. Identify edge cases before writing a line of code.
2. **Plan** — run `/spec-tasks` to turn the spec into an ordered task list.
3. **Implement** — Claude Code implements with tests in one session. Always include tests
   in the same generation pass — never implementation without tests.
4. **Review** — `gh pr create`, then run `/ultrareview` on the PR before merge.
   Security-sensitive PRs (new routes, new tables, auth changes) also run `/security-review`.
5. **Log** — update `docs/sup-docs/week-log.md` and `docs/sup-docs/roadmap-tracker.md`.

### Available Claude Code skills (use these, don't improvise)

| Skill              | When to use                                                                 |
| ------------------ | --------------------------------------------------------------------------- |
| `/spec`            | Before any new feature — write the spec first                               |
| `/spec-tasks`      | Turn a spec into an ordered implementation task list                        |
| `/security-review` | Any PR touching auth, new tables, new routes, file access, or secrets       |
| `/review`          | Standard PR review                                                          |
| `/ultrareview`     | Deep multi-agent review — run on all non-trivial PRs before merge           |
| `/verify`          | After implementation — confirm the feature works end-to-end in the real app |
| `/simplify`        | Post-implementation code quality pass                                       |

### The config-first test (Phase 2+)

Before shipping any module feature, ask: **did this require TypeScript changes outside
`packages/*` or `apps/*`?** If yes, something is wrong. Modules are seed SQL only.
The engine interprets them. No per-module backend TypeScript.

### Where humans must stay in the loop

- Writing or modifying ADRs (architecture decisions belong to humans)
- Security-sensitive code paths — always run `/security-review`
- Phase exit decisions — don't advance phases without explicit sign-off
- Pilot customer interactions and onboarding

### The `/.claude/` directory

- `/.claude/prompts/` — reusable prompt templates for common tasks
- `/.claude/context/` — domain documents loaded as context for specialized work

### Prompt templates

- `new-module.md` — seed SQL for a new business module (Phase 2+)
- `new-connector.md` — scaffold a third-party connector (Phase 3)
- `new-migration.md` — database migration with RLS, indexes, and rollback
- `new-route.md` — Hono route with Zod validation and tests
- `new-workflow-config.md` — workflow definition (states, transitions, SLA) as seed SQL

---

## Git conventions

**Branch naming:** `{type}/{ticket-id}-{short-description}`

- `feat/PLAT-123-add-parallel-approval`
- `fix/PLAT-456-sla-timer-not-cancelling`
- `chore/PLAT-789-upgrade-drizzle`
- `docs/PLAT-012-adr-002-workflow-engine`

**Commit messages follow Conventional Commits:**

```
feat(workflow): add parallel approval state machine pattern
fix(entity): invalidate schema cache on field delete
chore(deps): upgrade hono to 4.x
test(isolation): add RLS tests for workflow_events table
docs(adr): record decision on field validation strategy
```

**PR requirements:**

- [ ] Tests included (coverage does not drop)
- [ ] Tenant isolation tests updated if new tables/routes added
- [ ] ADR updated or new ADR created for significant decisions
- [ ] `CHANGELOG.md` entry for user-facing changes
- [ ] No `any` types introduced
- [ ] No direct `process.env` access introduced
- [ ] RLS policy present on all new tenant-scoped tables
- [ ] Claude review passed (automated check in CI)

---

## Running locally

```bash
# First time setup
cp .env.example .env.local
docker compose up -d          # starts Postgres, Redis, MinIO, Zitadel, Novu

# Install dependencies
pnpm install

# Run migrations
pnpm db:migrate

# Seed development data
pnpm db:seed

# Start all services in dev mode (hot reload)
pnpm dev

# Run tests
pnpm test                     # all tests
pnpm test:isolation           # RLS isolation tests only
pnpm test:e2e                 # end-to-end API tests

# Type check all packages
pnpm typecheck

# Lint
pnpm lint
```

**If `docker compose up` fails:** Check `docs/local-setup.md` for
platform-specific notes (Linux, macOS Apple Silicon, Windows WSL2).

---

## When you are stuck

1. Check the relevant ADR first — the decision and its reasoning are there
2. Check existing tests — they document expected behavior precisely
3. Check `/.claude/context/` for domain-specific guides (module system, patterns)
4. Check `docs/sup-docs/roadmap-tracker.md` to understand where this work fits in the phase plan
5. If a decision is not covered by an ADR, write one before implementing —
   document the context, options, and decision even if it's short
