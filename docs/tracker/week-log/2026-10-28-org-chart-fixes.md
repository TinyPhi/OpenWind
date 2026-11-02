## 2026-10-28 — Org chart opens expanded for small organisations, idle logout 15 minutes

**Session type:** two small admin-ui changes after live testing on a sandbox
**PR:** #1115.
**Spec:** [org-directory](../../specs/org-directory.md) R8.

The org chart API already returns the whole tree to every signed-in user; nothing filters by viewer.

| State                               | Event                      | Outcome                                                      | Kind      | Evidence                  |
| ----------------------------------- | -------------------------- | ------------------------------------------------------------ | --------- | ------------------------- |
| Organisation of 60 people or fewer  | Anyone opens the org chart | Opens fully expanded, even for a long chain of managers      | changed   | `org-directory.test.tsx`  |
| Organisation of more than 60 people | Anyone opens the org chart | Still opens to depth 3, deeper levels expand on click        | unchanged | `org-directory.test.tsx`  |
| No idle timeout configured          | Person is idle             | Logged out after 15 minutes (was 5); a configured value wins | changed   | `use-idle-logout.test.ts` |

**Live evidence:** a sandbox had 16 people in the tree, a chain about 8 levels deep. The chart showed only the first three levels, so the modal listed 4 people.

**Notes**

- Idle logout default (security policy, accepted 2026-10-30 by the owner): 15 minutes instead of 5, because 5 was too short on sandboxes and for admins reading long pages. The session is still ended client-side by the existing hook; the token and refresh lifetimes are unchanged. A deployment holding sensitive data can set `VITE_IDLE_LOGOUT_TIMEOUT_MINUTES` lower. Security review of the diff (2026-10-30): no findings. Idle logout ends the Zitadel session (`signoutRedirect`), an invalid, zero or negative override falls back to 15 and cannot disable it, and `GET /org-directory/tree` already returns the whole tenant tree to any signed-in user, so opening the chart expanded exposes nothing new.
- A deployment that sets `VITE_IDLE_LOGOUT_TIMEOUT_MINUTES` keeps that value; only the built-in default changed.
- Sending a person back to their organisation's own login link after sign-out depends on the login-key branding work, which is not merged yet, so it ships with that PR.
