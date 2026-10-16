# 2026-10-16 — Admin-ui assertion comments and dashboard unmount guard

**Session type:** Review follow-ups
**Branch:** `fix/PLAT-hardening-admin-ui-assertion-comments`
**Issues:** #874, #875, #846, #876 (findings from the review of #841)

- **Done.**
  - `require-platform-admin-mfa.tsx` (#874): comment on the error-body cast. `Response.json()` is typed `any`, so
    the cast documents the `{ error?: string }` contract rather than satisfying the compiler.
  - `callback.tsx` (#875): comments on both casts. The first widens `user.profile` (typed non-optional) to
    include `undefined`, which keeps the `?.` below defensive for a stored user with no profile; the second
    narrows an `unknown` claim to the roles map. I first tried replacing the first cast with a typed
    declaration (`IdTokenClaims` already has a string index signature), but that narrows `profile` to non-optional
    and the lint rule `no-unnecessary-condition` rejects the `?.`, so the cast stays.
  - `dashboard.tsx` (#846): comments on both remaining `fetchWithAuth` casts (the sandbox list was restored after
    #846 was filed, so there are two, not one).
  - `dashboard.tsx` (#876): the session fetch ignores its answer once the effect is cleaned up.
- **Corrections to the issues.** #874 says `res.json()` returns `unknown` (it returns `any`) and #875 says the
  custom claim keys are not part of `Profile` (they are, via the index signature; the cast is for the `undefined`
  widening, not the keys), so the issue snippets were not copied as written. #876's `setError` no longer exists in that effect (its `catch` is silent by design).
- **Verified.** A StrictMode test in `dashboard.test.tsx` where the first session fetch resolves last with
  different data fails before the guard (the stale name wins) and passes after.
- **Deferred.** `refresh()` (sandbox list) also runs twice under StrictMode and has the same stale-overwrite
  shape; it was not in #876's scope. The type-guard casts in `callback.tsx`'s `isHandoffState` have no inline
  comment either (not named by an issue).
