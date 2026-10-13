# 2026-10-13 — admin-ui follow-ups from #786 and #862 (#850, #849, #886)

**Session type:** Code
**Branch:** `fix/PLAT-850-admin-ui-shared-helpers`

- #850: the shared `initials()` in `lib/format.ts` now returns `"U"` for empty or whitespace-only names, matching `InitialsAvatar`.
- #849: `record-create.tsx` no longer has private copies of `initials`, `singularize` and `useOutsideClick`; it imports the shared ones. The shared `useOutsideClick` keeps the callback in a ref, so the pickers' inline callbacks no longer re-subscribe the listener on every render.
- #886: `GlobalErrorBanner` reads the one-shot session-expired notice once at module load instead of in the `useState` initializer, so React Strict Mode's double initializer in dev no longer swallows it. The banner tests now load a fresh module per test and include a Strict Mode render.
- Not in this change: #810 (needs a browser telemetry sink; `@platform/telemetry` is Node-only) and #843 (restore-or-document the ticket-row hover scale, a visual call).
