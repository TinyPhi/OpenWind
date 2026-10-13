# 2026-10-13 — Notification failure badge (#571 T33)

**Session type:** Code
**Branch:** `feat/PLAT-571-notification-failure-badge`

- Added `GET /entities/:id/notification-failures` (agent/admin, ticket-access checked): the last
  24 hours of `notification.channel_failed` audit entries for the ticket, built on the audit `action`
  filter from #879. It passes `resourceType: "ticket"` so the `(tenant, resource_type, resource_id)`
  index serves the lookup. The response carries only the channel and the time, not `errorSummary`.
- Added `NotificationFailureBadge` and mounted it beside the coverage-gap badge on the ticket detail
  page, gated on the real admin or agent role and a non-deleted ticket. Unlike the coverage badge it
  stays on closed tickets, because a failed notification is still worth seeing there.
- Tests: a real-Postgres isolation suite for the route (window, action and ticket filters, no error
  text, role gate, cross-tenant 404; mutation-checked by dropping the window and the action filter),
  badge unit tests, and page-level mount tests.
- Open: T29 (SMS/WhatsApp/voice provider delivery) is the remaining #570 scope.
