# 2026-10-10 — Admin UI blank-name initials fallback (#850)

**Session type:** Issue #850 implementation and PR review follow-up
**Branch:** `fix/850-initials-fallback`

- The shared `initials()` formatter now returns `"U"` for empty and whitespace-only display names,
  and all production avatar callers use that formatter instead of private copies.
- Existing non-empty name behavior stays unchanged; punctuation-only names continue to preserve
  their first character because display-name sanitization is outside this issue.
- The formatter unit test reproduces the previous empty result and covers both blank input forms.
- This change is stateless: it reads only the current function argument and has no persistent state
  or external effects.
