# Dependency graph & impact analysis

Closes a real gap: before this, "what depends on X" or "what breaks if I change Y" had
no answer beyond grep/Explore-agent search across the monorepo. `dependency-cruiser` (root
devDependency, config at `.dependency-cruiser.cjs`) gives a queryable, transitive answer
instead.

This does **not** replace the engine context docs (`entity-engine.md`, `workflow-engine.md`,
`automation-engine.md`) — those encode _why_ an invariant exists (e.g. why `NOWAIT` maps to
423). A dependency graph only knows _what imports what_; read the relevant context doc first
for intent, use this for "who else touches this file."

## Commands

```bash
pnpm dep:check                              # validate import boundaries (same rules as
                                             # eslint.config.mjs, but on the full transitive
                                             # graph — also catches boundary violations
                                             # laundered through a re-export, which eslint's
                                             # per-file import-specifier matching can miss)

pnpm dep:impact -- '<path-regex>'           # what depends on this, directly or transitively
```

`dep:check` is deliberately **not** wired into CI or `pnpm ci` — doing so would mean editing
`.github/workflows/*`, which is off-limits to autonomous edits (CLAUDE.md). `eslint` (already
CI-gated) stays the enforcement mechanism; `dep:check` is a second, ad hoc, stronger-in-some-
ways-not-others view of the same rules (see the false-negative note below on why "stronger"
isn't unconditional). Wiring it into CI is a human call, not made here.

`dep:impact` wraps `depcruise --reaches`. Two usage patterns, because of how the graph
resolves cross-package imports (see gotcha below):

- **Impact within a package** (an internal file, not exported from `index.ts`): target the
  source path directly.
  `pnpm dep:impact -- '^packages/entity-engine/src/pagination\.ts$'`
- **Impact of a package's public API** (an `@platform/*` import from another package):
  target its **built** entry point, not the source file.
  `pnpm dep:impact -- '^packages/logger/dist/index\.js$'`

Both scripts pass `--cache` (default location `node_modules/.cache/dependency-cruiser`,
already covered by the repo's `node_modules/` gitignore entry) — repeated queries in the same
session only re-parse files that changed since the last run.

## Gotcha: `--cache` only sees files git knows about

`--cache` (both scripts) diffs against `git` to decide which files changed since the last cruise
— a brand-new file that hasn't been `git add`ed yet is invisible to it, and the run silently
reports the pre-existing (stale) result instead of an error. Verified empirically while adding
the `no-cross-app-*` rules below: a genuinely violating new file gave a clean
`✔ no dependency violations found` from `pnpm dep:check` right up until `git add`, at which point
the exact same command correctly reported it. Plain `depcruise` (no `--cache`) always re-scans
the full tree and doesn't have this gap — reach for that (or `git add` first) when checking work
you haven't staged yet, and don't trust a clean `dep:check`/`dep:impact` result for files still
sitting untracked.

## Gotcha: forbidden imports can't be told apart from missing ones by path alone

The rules in `.dependency-cruiser.cjs` (`no-cross-module`, `packages-no-apps`, `packages-no-modules`,
`entity-engine-no-workflow-or-automation`, `workflow-engine-no-automation`, `no-cross-app-*`) each
match **two**
forms of the same violation, and dropping either form silently breaks the rule:

1. **A resolved path** (e.g. a relative import that reaches into another module's folder) —
   dependency-cruiser follows it like any other file and matches on the real resolved path.
2. **A raw bare specifier** (e.g. `import "@platform/workflow-engine"`, `import "@modules/helpdesk"`) —
   this is the realistic case, matching the codebase's actual `@platform/kebab-case`/
   `@modules/kebab-case` import convention. A forbidden cross-package/cross-module import is,
   by construction, never declared as an npm dependency (that's what makes it forbidden), so
   pnpm never symlinks it into `node_modules`, and dependency-cruiser **cannot resolve it to a
   path at all**. Verified empirically: an unresolvable import is still recorded with `resolved`
   set to the raw specifier text (`"@platform/workflow-engine"`, `couldNotResolve: true`), and
   path-matching runs against that field regardless of whether resolution succeeded — so a rule
   that only matches form 1 reports a clean "no violations" on the exact realistic import it was
   meant to catch. This was caught in review before it shipped; every rule here matches both
   forms. If you add a new boundary rule, match both, or it will silently under-enforce.

App package names (`@platform/api`, `@platform/admin-ui`, `@platform/worker`) don't follow a
predictable `@platform/app-*` prefix, so `packages-no-apps` reads each app's `package.json`
`name` field at config-load time rather than pattern-matching a prefix.

## Gotcha: cross-package `--reaches`/`--focus` edges resolve through `dist/`, not `src/`

There's no root `tsconfig.json` path-mapping `@platform/*` to source — packages consume each
other exactly like npm would, through the pnpm-symlinked `node_modules` entry, which points at
`package.json`'s `main` (`./dist/index.js`). So a cross-package edge is genuinely recorded as
`packages/logger/dist/index.js`, not `packages/logger/src/index.ts` — querying `--reaches` on
the `src/index.ts` path for a package boundary silently returns nothing (not an error), because
no edge in the graph actually points there.

**Consequence:** `dep:impact`'s cross-package accuracy depends on `packages/*/dist` being
built and current. A stale or missing `dist` under-reports impact the same way a stale index
would in any precomputed-graph tool — treat an empty/surprisingly-small result as inconclusive,
not as proof nothing depends on the file, and re-run `pnpm build` before trusting it.

`dist/*.js` is otherwise excluded from being crawled as an independent module (via
`options.doNotFollow`, anchored to whole path segments — `(?:^|/)(?:node_modules|dist)(?:$|/)`,
not a bare `dist` substring match, which would wrongly swallow a real source folder like
`src/distribution/`) — without it, every compiled file under `apps/*/dist` and `packages/*/dist`
gets treated as its own first-class module, silently doubling the graph with a redundant
compiled-output mirror of the real source graph (verified: 1307 modules / 5116 dependencies
with dist included as crawl roots, vs. 698 / 3024 without — same repo).

## What this doesn't do

- No framework-specific understanding — it's a syntactic import/require graph, not aware of
  Zod schema inference, Drizzle query builders, or Hono route wiring. It answers "who imports
  this file," not "who is affected by this runtime behavior."
- Re-cruises the whole graph each run (`--cache` only skips re-parsing unchanged **tracked**
  files — see the git-visibility gotcha above); it isn't a persisted index across sessions the
  way a language server or a tool like GitNexus's MCP server would be. Fine at this repo's
  current scale (a few seconds cold).
