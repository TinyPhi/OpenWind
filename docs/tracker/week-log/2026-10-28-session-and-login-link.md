## 2026-10-28 — Idle logout 15 minutes, and back to the organisation's own login link

**Session type:** small change after live testing (owner-directed, on `tushar`)
**PR:** none yet.
**Spec:** [multi-org-sandbox](../../specs/multi-org-sandbox.md) R13 (amended).

| State                                           | Event                                  | Outcome                                                            | Kind       | Evidence                              |
| ----------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ | ---------- | ------------------------------------- |
| No timeout configured                           | Person is idle                         | Logged out after 15 minutes (was 5); a configured value still wins | changed    | `use-idle-logout.test.ts`             |
| Person opened their organisation's own link     | Link matches a real organisation       | Its login key is remembered in this browser                        | introduced | `login.test.tsx`, `login-org.test.ts` |
| Remembered key, visit to plain `/login`         | Sign-out, idle logout, expired session | Goes on to `/login?org=<key>`                                      | introduced | `login.test.tsx`                      |
| A link that already names an organisation       | Visit                                  | No redirect                                                        | unchanged  | `login.test.tsx`                      |
| Nothing remembered, or a malformed stored value | Visit plain `/login`                   | Stays on plain `/login`                                            | unchanged  | `login.test.tsx`, `login-org.test.ts` |
| Storage blocked or throwing                     | Any of the above                       | Falls back to plain `/login`, no error                             | unchanged  | `login-org.test.ts`                   |

**Notes**

- The redirect lives in the login page, so every path to `/login` is covered. The sign-out redirect to the identity provider stays `/login`, because the provider only accepts redirect addresses registered in advance.
- The R13 line "no org is remembered across logins" is amended: the login key is the one thing remembered.
- A browser that used two organisations' links lands on the last one that matched.
- A deployment that sets `VITE_IDLE_LOGOUT_TIMEOUT_MINUTES` keeps that value; only the built-in default changed. The local `.env.local` sets 30.
