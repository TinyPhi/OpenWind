# 2026-09-30 — third-party notice for adapted agent skills

**Session type:** License compliance (docs-only)
**Branch:** `docs/third-party-notices`

- Five Claude Code skills (`debugging-and-error-recovery`, `doubt-driven-development`,
  `idea-refine`, `interview-me`, `source-driven-development`) are condensed adaptations of the
  skills of the same name in [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills),
  which is MIT-licensed. The repo carried no copy of that license.
- Added `THIRD_PARTY_NOTICES.md` at the root with the upstream source, the adapted files and the
  full MIT license text (`Copyright (c) 2025 Addy Osmani`). No existing file changed.
- Verified: `prettier --check` clean. No code touched, so the exit condition does not apply.
