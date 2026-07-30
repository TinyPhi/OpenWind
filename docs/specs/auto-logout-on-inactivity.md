# Spec: Auto-Logout on Inactivity

**Status:** approved-pending-plan-lock
**Date:** 2026-07-25

## §C Context

Session should end automatically after 5 minutes of no user interaction, for
basic security hygiene (shared/unattended machines). No prior inactivity
handling exists in `apps/admin-ui`.

## §R Requirements

- **R1**: Track user activity via standard DOM events (`mousemove`, `keydown`,
  `mousedown`, `touchstart`, `scroll`) while any authenticated route is
  mounted. Any of these resets the inactivity timer.
- **R2**: After 5 minutes (300_000ms) with no activity, call the existing
  `authProvider.logout()` flow and redirect to `/login` — same effect as a
  manual logout, not a separate code path.
- **R3**: Timer runs only while authenticated (mounted inside the existing
  `<Authenticated>`-gated route tree in `App.tsx`, not on `/login` or
  `/auth/callback`).
- **R4**: Listeners/timer are cleaned up on unmount (no leak if the
  `Authenticated` gate itself unmounts, e.g. on an already-expired session).
- **R5**: No new dependency — implemented with plain `addEventListener` +
  `setTimeout`, consistent with the rest of the codebase having no existing
  idle-timer library.

## §NR Non-Requirements

- No user-facing warning/countdown modal before logout — out of scope for
  this pass, a plain silent logout on timeout.
- No configurability (fixed 5 minutes, not a tenant/user setting).

## §I Interfaces

```typescript
// apps/admin-ui/src/hooks/use-idle-logout.ts
export function useIdleLogout(timeoutMs?: number): void;
```

Mounted once inside the authenticated route tree in `App.tsx`, alongside
`EntityTypeProvider`/`Layout`.

## §T Tasks

Single phase — small, self-contained hook + one call site.

| task                                                                                                                   | requirement    | status |
| ---------------------------------------------------------------------------------------------------------------------- | -------------- | ------ |
| T1: `useIdleLogout` hook — activity listeners, timer, calls `authProvider.logout()` + navigates to `/login` on timeout | R1, R2, R4, R5 | todo   |
| T2: Wire into `App.tsx`'s authenticated route tree only                                                                | R3             | todo   |
| T3: Unit test (fake timers) — resets on activity, fires logout after timeout, cleans up listeners on unmount           | R1, R2, R4     | todo   |

## Acceptance Criteria

| id  | text                                                           | verify                                           |
| --- | -------------------------------------------------------------- | ------------------------------------------------ |
| AC1 | Any tracked activity event resets the 5-minute timer           | `pnpm --filter admin-ui test -- use-idle-logout` |
| AC2 | No activity for 5 minutes triggers logout + redirect to /login | same                                             |
| AC3 | Hook only active on authenticated routes                       | manual verification (browser)                    |
