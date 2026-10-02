# AGENTS.md — AI Engineering Guide for OpenWind

This document defines core rules, constraints, and workflows for autonomous AI coding agents (Antigravity, Codex, Claude Code, Cursor, Windsurf). Read before writing any code.

---

## 1. System Overview & Architecture

OpenWind is a modular, workflow-native business platform built on a config-first architecture:

- **`apps/api`**: REST & RPC server built with **Hono**.
- **`apps/worker`**: Background job processing via **BullMQ** (outbox, automations, SLA, schedulers).
- **`apps/admin-ui`**: Single unified frontend for admins, agents, and customers using **Vite + React 18 + Refine + shadcn/ui**.
- **`packages/*`**: Shared core engines (`entity-engine`, `workflow-engine`, `automation-engine`, `db`, `auth`, `config`, `ui`).
- **`modules/*`**: Business domains (CRM, Helpdesk, HRMS, etc.).

### Critical Invariants

1. **Config-First Modules (ADR-004)**: `modules/*` contains **only seed SQL and a one-line `index.ts` stub**. Never write TypeScript business logic in `modules/`. Modules configure shared platform engines.
2. **Strict Multi-Tenancy & RLS (ADR-001)**: Every database query and route must enforce tenant isolation and Row-Level Security (RLS). Never bypass tenant boundaries.
3. **Dependency Graph Direction**:
   - `apps/*` → `packages/*`
   - `modules/*` → `packages/*` (zero cross-module imports)
   - `entity-engine` → `db` only
   - `workflow-engine` → `db`, `entity-engine`
4. **Off-Limits Autonomous Areas**:
   - Parallel approval logic (`#65`) is off-limits.
   - ADR files in `docs/decisions/` are human-authored only.

---

## 2. TypeScript & Code Style Rules

### Absolute Type Safety

- **Strict Ban on `any`**: Never use `any` or un-narrowed `unknown`. Always use Zod validation, discriminated unions, or strict generic constraints.
- **Zod-Derived Types**: Types must derive from schemas, never the reverse:
  ```typescript
  export const TicketSchema = z.object({
    id: z.string().uuid(),
    subject: z.string().min(1),
  });
  export type Ticket = z.infer<typeof TicketSchema>;
  ```
- **Configuration & Environment**: Never call `process.env` directly. Always import from `@platform/config`.
- **Function Signatures**: Explicit return types are required on all exported functions.
- **Functional Patterns**: Prefer declarative and functional patterns; avoid classes for business logic.

---

## 3. Frontend & React State Guidelines (`apps/admin-ui`)

- **Centralized HTTP Client**: Always use `fetchWithAuth` from `lib/api.js`. Never call raw `fetch()` directly in components.
- **No Cascading `setState` in `useEffect`**:
  - Never call `setState` synchronously within `useEffect` to copy props or compute derived state.
  - Compute derived values directly in render or with `useMemo`.
- **Form State Consolidation**:
  - Do NOT create individual `useState` hooks for each form field.
  - Consolidate form fields into typed state models (e.g. `useState<FormData>(initialData)` or schema-driven forms) with type-safe updater helpers.
- **Server State & Caching**: Prefer declarative query hooks (TanStack Query / Refine hooks) over manual `useState(loading)` + `useEffect` fetch loops.
- **Component Decomposition**: Encapsulate dialogs, modals, and drawers into dedicated subcomponents rather than holding all modal states in parent page roots.

---

## 4. Frontend Performance Engineering & Anti-Patterns (`apps/admin-ui`)

- **Route-Level Code Splitting (`lazy-routes.ts`)**:
  - All page components must be defined with dynamic `lazy()` imports in `src/lazy-routes.ts` and loaded through `<Suspense>`.
  - NEVER statically import page components directly in `App.tsx`.
  - Heavy specialized dependencies (e.g. `@reactflow/*`, `@dagrejs/dagre`, `d3-*`, `@dnd-kit/*`, `@superset-ui/embedded-sdk`) MUST remain isolated to their respective route chunks.
  - The main application entry chunk must remain under 700 kB (`chunkSizeWarningLimit: 700`).
- **Eliminate Network Waterfalls**:
  - NEVER trigger sequential API requests across cascaded `useEffect` cycles.
  - Consolidate data requirements and dispatch independent requests concurrently using `Promise.all` or composite endpoints.
  - Guard against duplicate fetches during component mounting with ref flags or shared promise caches.
- **Strict Ban on JavaScript Hover State**:
  - NEVER use React state (`useState`, `useHoverStyle`, `onMouseEnter`/`onMouseLeave`) for presentation states like hover, active, or focus.
  - Use native CSS pseudo-classes (`:hover`, `:focus-visible`, `:active`), CSS transitions, and CSS variables in `index.css`. Presentation styles must run on the browser compositor thread with zero React re-renders.
- **High-Frequency Event Listener Throttling & Passive Mode**:
  - Global window event listeners (`mousemove`, `scroll`, `touchmove`, `resize`) must ALWAYS be throttled (e.g., 10 seconds for idle timers in `use-idle-logout.ts`).
  - ALWAYS attach high-frequency event listeners with `{ passive: true }` to avoid blocking scroll and main thread execution.
- **Shared Request Deduplication & In-Memory Caching**:
  - Data fetched by multiple components simultaneously (e.g. `/api/users`, unread notification counts) must use single-flight promise deduplication (e.g. `fetchUsersShared()`) so only one HTTP request leaves the browser.
- **Offline-First Assets & Zero 404s**:
  - NEVER depend on external third-party avatar CDNs (e.g. DiceBear); use local offline SVG generators (`UserAvatarBadge`).
  - Ensure all static assets in `index.html` and components point to verified files in `public/` (e.g. `/favicon.svg`).
- **Non-Blocking Head Scripts**:
  - Scripts placed in `index.html` `<head>` (e.g. `/env.js`) MUST use the `defer` attribute to prevent DOM parser blocking.

---

## 5. Git & Commit Conventions

Commits are strictly validated by **commitlint** and **husky**:

- **Format**: `<type>(<scope>): <lowercase subject>`
- **Allowed Types**: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `chore`, `ci`, `security`
- **Allowed Scopes**: `admin-ui`, `api`, `worker`, `entity-engine`, `workflow-engine`, `automation-engine`, `db`, `auth`, `ui`, `config`, `perf`, `security`, `dx`, `deps`
- **Line Length Constraints**:
  - Subject: **lowercase**, max **100 characters**.
  - Body lines: max **150 characters**.
- **Example**:
  ```bash
  git commit -m "perf(admin-ui): consolidate form state and eliminate derived state effects"
  ```

---

## 6. Verification Gate (Exit Condition)

Before finishing any task or marking work complete, all four checks must pass cleanly with **zero errors and zero warnings**:

```bash
# Workspace exit check
pnpm typecheck          # Zero TypeScript errors across all workspaces
pnpm lint               # Zero ESLint warnings (--max-warnings=0)
pnpm test               # All unit and integration tests green
pnpm test:isolation     # Database RLS isolation tests pass
```

To run checks for a single workspace (e.g. `admin-ui`):

```bash
pnpm --filter @platform/admin-ui typecheck
pnpm --filter @platform/admin-ui lint
pnpm --filter @platform/admin-ui test
```

---

## 7. Common Commands Cheat-Sheet

```bash
docker compose up -d       # Start local services (Postgres, PgBouncer, Redis, OpenBao, ClamAV)
pnpm dev                   # Local hot-reload dev servers
pnpm db:migrate            # Run pending database migrations
pnpm db:seed               # Seed initial development data
pnpm dep:check             # Validate monorepo dependency boundaries
```
