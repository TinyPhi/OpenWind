# 2026-10-20 — NullPool guard nits (#795, #796, #797)

- #795: the guard accepts the class written qualified (`pool.NullPool`, `sqlalchemy.pool.NullPool`,
  `sa.NullPool`) as well as bare, so a later Superset release that changes its import style no longer stops
  startup with a misleading error. A qualified name that is not `NullPool` (for example `pool.QueuePool`) is
  still refused. Tests added; they fail without the change.
- #796: `import ast` is at module level in `superset_config.py` instead of inside each helper.
- #797: the one-liner and comment-body tests now also assert the source changed. The issue said their
  existing `assertIn` could pass on an unchanged source; it could not (it looks for text the original does
  not contain), so this is belt-and-braces, not a fix.
- Not done: #812 and #813 (audit payload field, statement timeout in the log handler) need a real Superset
  to verify; #810 needs a browser telemetry design first (admin-ui has no browser reporting).
