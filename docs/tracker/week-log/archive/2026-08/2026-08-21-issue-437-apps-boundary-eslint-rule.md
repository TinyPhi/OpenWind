## 2026-08-21 — Issue #437: enforce the `apps/*` → `apps/*` boundary

**Session type:** Bug fix / tooling hardening
**Branch:** `chore/PLAT-437-apps-boundary-eslint-rule`

### Completed this session

#### Issue #437 (eslint.config.mjs documented an apps/\* boundary rule that didn't exist)

- Added a generated `no-restricted-imports` block per `apps/*` directory to `eslint.config.mjs`,
  mirroring the existing `packages/entity-engine`/`packages/workflow-engine` per-directory
  pattern. Confirmed via grep: zero existing cross-app imports today, so nothing broke.
- Also added a matching `no-cross-app-*` rule per app to `.dependency-cruiser.cjs`, per this
  repo's own documented convention ("if you add a new boundary rule, match both, or it will
  silently under-enforce" — `.claude/context/dependency-graph.md`).
- `/review` (forked execution, 3 passes) caught real, verified bugs each round, all fixed here:
  - **Round 1:** the first eslint attempt used fixed relative-path depths (`"../../worker/*"`)
    that only match an import written from exactly that directory depth — verified empirically
    that 230/244 `apps/api/src/**/*.ts` files sit at a depth the pattern misses entirely, and a
    deep relative cross-app import produced zero lint errors. Also flagged: the new eslint rule
    had no dependency-cruiser mirror, and the three blocks were hand-duplicated instead of
    generated.
  - **Round 2 (fixing round 1):** switched to `**/<app>/**` globs to catch any depth — but this
    over-corrected: verified empirically that a same-app-only relative import through a local
    subfolder coincidentally named `worker` (e.g. `apps/api/src/worker/helper.ts`, entirely
    inside apps/api) now false-positives as a "cross-app" import. Also caught: an empty-siblings
    edge case in `.dependency-cruiser.cjs`'s generated rule (`^(?:)` matches every string,
    inverting a no-op into "forbid everything" — not reachable at today's 4 apps, but latent),
    and a redundant duplicate `apps/` directory listing.
  - **Round 3 (fixing round 2):** resolved the safe-vs-complete tension by splitting
    responsibility the way the rest of this file already does — eslint's `no-restricted-imports`
    only matches the literal specifier text, so it now only checks the exact bare package name
    (`@platform/worker` etc., the codebase's actual import convention, zero false-positive risk);
    dependency-cruiser's mirrored rule resolves real file paths, so it's the one that correctly
    and completely catches the relative-path form at any depth without the same-name-subfolder
    trap. Guarded the empty-siblings case by skipping rule generation entirely when there are no
    sibling apps. Deduplicated the directory listing.
  - **Round 3 also verified as a pre-existing, shared, out-of-scope limitation** (not fixed):
    `no-restricted-imports` doesn't inspect dynamic `import()` expressions — true of all 5
    boundary-rule categories in this file already, not something #437 introduced.
- Found and documented, while proving the dependency-cruiser mirror works: `--cache` (both
  `dep:check`/`dep:impact`) diffs against `git` to find changed files — a genuinely-violating
  brand-new file gave a clean "no violations found" result until `git add`ed. Not a bug (this is
  documented dependency-cruiser behavior once you know to look for it), but a sharp,
  non-obvious edge worth the same explicit warning `dependency-graph.md` already gives the
  `dist/`-staleness gotcha — added as a new "Gotcha" section there.
- No test harness exists for `eslint.config.mjs`/`.dependency-cruiser.cjs` directly (no root
  vitest config; confirmed no PR in this lineage, including #438, has one either) — verified
  instead via throwaway fixture files exercising each specific scenario found above, run through
  the real `eslint`/`depcruise` CLIs, then removed. PR title carries `[skip-tests-check]`.

### Verification

- `pnpm typecheck`: PASS
- `pnpm lint`: PASS (fixture probes for the same-app false-positive and the real cross-app
  bare-specifier case both behaved correctly; removed before commit)
- `npx depcruise --config .dependency-cruiser.cjs --output-type err apps packages modules`
  (no `--cache`, so immune to the git-visibility gotcha found above): clean on the real tree,
  correctly flags a real cross-app relative import in a throwaway fixture (removed before commit)
