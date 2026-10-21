# 2026-10-20 — ticket create: the remark warning is no longer lost when `returnTo` is used

- From the #1040 review: `record-create.tsx` forwarded the "remark could not be added" notice through
  navigation state to every destination, but only the record page renders it. With a `returnTo` target (the
  hosted handoff flow) the warning was silently dropped.
- Now: without `returnTo` the notice goes to the record page as before; with `returnTo` it is shown through the
  global alert dialog and the user still lands on the `returnTo` page.
- Tests (`record-create.test.tsx`): the record page receives the notice on a warning, no notice without a
  warning, and the `returnTo` case uses the global alert with no navigation state. The last fails on the old
  code. This also fills the "no create-side test" gap noted in the #1040 review.
