# 2026-09-28 — ANTHROPIC_API_KEY is optional (#700)

**Session type:** Config
**Issue:** #700 (surfaced as ADR-018 OQ-8)
**Branch:** `fix/PLAT-700-anthropic-key-optional`

`packages/config` required `ANTHROPIC_API_KEY` at startup, although nothing consumes
`@platform/ai` yet (3C hasn't started).

- The key is now optional in the env schema. An empty or whitespace value counts as unset.
- `packages/ai`'s `createClient()` throws a typed `AiNotConfiguredError` (code
  `AI_NOT_CONFIGURED`) when the key is unset. `isAiConfigured()` lets future AI features branch
  without try/catch.
- `packages/ai` gains a vitest setup (with `@platform/config` aliased to source) and three tests.
  `packages/config` gains three schema tests.
- `.env.example` now leaves the key commented out rather than using a non-empty placeholder,
  which would have looked configured. `docs/local-setup.md` marks it optional.
