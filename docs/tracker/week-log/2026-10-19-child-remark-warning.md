# 2026-10-19 — Tell the caller when a sub-task's remark comment fails (#1002)

**Session type:** Implementation
**Branch:** `fix/PLAT-child-remark-warning`
**Issues:** #1002

- **Done.**
  - `POST /entities/:id/children` still returns `201` when posting the remark as the first comment
    fails, but now adds `warnings: ["remark_comment_failed"]` to the body. No `warnings` key
    otherwise. The remark itself is always stored on the sub-task.
  - The sub-task panel shows a notice when the response carries that warning.
  - Tests: API (warning present on failure, absent on success) and admin-ui (notice shown).
- **Decision.** Option 1 from the issue (non-fatal warning) rather than posting the comment in the
  create transaction, which would change the best-effort design. Owner picked the lower-risk option.
- **Not done.** `POST /entities` (full ticket) has the same best-effort pattern and returns no
  warning yet.
