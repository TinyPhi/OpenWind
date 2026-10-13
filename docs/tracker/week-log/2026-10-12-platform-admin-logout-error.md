# 2026-10-12 — Platform-admin logout error feedback (#877)

**Session type:** Issue #877 implementation
**Branch:** `fix/877-logout-error`

## Decision

Catch rejected platform-admin logout attempts at the dashboard boundary and display the existing
inline alert with a stable retry message. The session remains active because logout did not
complete, and no redirect is attempted.

The message deliberately omits the underlying identity-provider error. This costs operators some
diagnostic detail in the UI, but avoids exposing infrastructure details and keeps the recovery
action clear. Detailed failures remain available through application logging owned by the auth
provider path.

Residual exposure: a failed logout leaves the current browser session active until the operator
retries or closes it. This change is not stateful; it only reflects the result of the current logout
request in component state.

## Verification plan

- A rejected logout promise displays `Logout failed. Please try again.` and does not produce an
  unhandled rejection.
- A successful logout with a redirect continues to use the existing redirect path.
- The focused dashboard tests, admin-ui typecheck, lint, and full admin-ui test suite pass.
