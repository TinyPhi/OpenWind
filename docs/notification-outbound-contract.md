# Notification Outbound API Contract

> Handoff spec for the team building the email/SMS/WhatsApp delivery service.
> OpenWind calls **your** endpoint; you own everything downstream of this contract.

Status: **draft — request format is stable, response contract needs your input** (see
"Open questions" at the bottom).

---

## How this fits together

OpenWind's own in-app notification system (bell icon, inbox) is fully self-contained and
already works independently of this contract. Every in-app notification also queues a call
to your service, so the actual email/SMS/WhatsApp gets sent. If your service is down or
unreachable, in-app delivery is unaffected — only the outbound channel is delayed/retried.

```
OpenWind trigger (ticket assigned, comment mention, etc.)
        │
        ▼
  in-app notification (DB row + live push)  ──always succeeds independently──▶ user sees it in-app
        │
        ▼
  POST to your service  ◀── this document describes exactly this call
```

---

## Endpoint

- **Method:** `POST`
- **URL:** configured on our side via an env var (`NOTIFICATION_SERVICE_URL`) — give us the
  URL you want us to call, plus any auth header/token you need us to send (not yet wired —
  see open questions).
- **Content-Type:** `application/json`

## Request body

```jsonc
{
  "notificationId": "c5a4bf30-3ba0-4948-a4ef-25aa5f36f366", // stable, unique per notification — use for de-dupe
  "title": "New assignment",
  "body": "Priya Sharma assigned you a ticket",
  "link": "/records/support-ticket/1a8f1622-19a7-47db-992f-ddd3dc2261dd", // relative path — see note below
  "recipients": [
    { "userId": "378676044544081922", "email": "user@example.com" },
    // email may be null if we couldn't resolve it — see open questions
  ],
  "channels": {
    "email": true,
    "sms": false,
    "whatsapp": false,
  },
}
```

### Field reference

| Field                 | Type             | Notes                                                                                                                                                                                                                                                                             |
| --------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notificationId`      | `string` (UUID)  | Stable, unique per notification. **Use this as your idempotency key** — see "De-dupe" below.                                                                                                                                                                                      |
| `title`               | `string`         | Short heading, e.g. "New assignment", "Access granted", "System error".                                                                                                                                                                                                           |
| `body`                | `string`         | One-line human-readable message. Never contains raw free-text (e.g. a comment's actual text) — always a generic description.                                                                                                                                                      |
| `link`                | `string \| null` | Relative path into the app (e.g. `/records/<type>/<id>`), or `/admin/system-logs` for system errors, or `null`. **You'll need to prefix with the app's base URL** to make it a clickable link in an email — we don't currently send the base URL in this payload (flagged below). |
| `recipients`          | `array`          | Usually 1 entry; can be more (e.g. an SLA breach notifies every workflow admin).                                                                                                                                                                                                  |
| `recipients[].userId` | `string`         | Our internal user ID (same as the Zitadel user ID — no translation needed if you already integrate with Zitadel elsewhere).                                                                                                                                                       |
| `recipients[].email`  | `string \| null` | Resolved from Zitadel at send time. `null` if we couldn't resolve it (deleted/unknown user) — **skip that recipient for email, don't error the whole call.**                                                                                                                      |
| `channels.email`      | `boolean`        | Currently **always `true`** for every notification type — email is the only channel live today.                                                                                                                                                                                   |
| `channels.sms`        | `boolean`        | Currently **always `false`** — reserved for when SMS is wired up. Don't build against this being `true` yet.                                                                                                                                                                      |
| `channels.whatsapp`   | `boolean`        | Currently **always `false`** — same as above, reserved.                                                                                                                                                                                                                           |

### Notification types you'll see in `title`/`body` (for context, not part of the payload)

| Trigger                           | Example title                | Example body                                                       |
| --------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| Ticket assigned                   | "New assignment"             | "`{name}` assigned you a ticket"                                   |
| Comment mention                   | "Comment mention"            | "`{name}` mentioned you in a comment"                              |
| Mention that grants new access    | "Access granted via mention" | "`{name}` granted you access to this ticket via a comment mention" |
| Reply to your comment             | "New reply"                  | "`{name}` replied to your comment"                                 |
| Access granted (explicit)         | "Access granted"             | "`{name}` granted you access to a ticket"                          |
| Access revoked                    | "Access revoked"             | "`{name}` revoked your access to a ticket"                         |
| SLA breach                        | "SLA breached"               | "A ticket in your workflow has breached its SLA"                   |
| System error                      | "System error"               | Free-text reason (internal, admin-only recipients)                 |
| Automation-rule-configured notify | (tenant-configured)          | (tenant-configured, from the automation rule's own config)         |

These are just for context — you receive the already-rendered `title`/`body`, not the trigger type itself.

---

## Response contract (what we expect back)

- **Any `2xx` status** → we treat the handoff as successful, mark it delivered on our side, and don't retry.
- **Any non-`2xx` status** (4xx or 5xx) → we treat it as a failure and retry.
- **Retry policy:** up to 3 attempts total, exponential backoff (~1s, 2s, 4s between attempts).
- **After 3 failed attempts:** we give up, log it internally, and stop retrying that notification. We don't currently expect a response body — we only check the status code.

**Timeout:** not currently set on our side (uses the platform HTTP client's default). If your
service can be slow, tell us what timeout to configure — we'll add one explicitly rather than
relying on a default.

## De-dupe / idempotency

We make a best-effort attempt to call your endpoint exactly once per notification (we mark our
own internal state before calling, so a retry on our side after a partial failure won't re-call
you for the same `notificationId`). But in rare failure windows (e.g. our process crashes
between calling you and recording success) **we could call you twice for the same
`notificationId`**. If sending the same email/SMS twice would be a problem for you, please
dedupe on `notificationId` on your side too — don't rely solely on us.

---

## Open questions — need your input before this is fully wired up

1. **Auth**: do you want an API key / bearer token on our calls? If so, tell us the header
   name and we'll add it.
2. **Base URL for `link`**: do you want us to send the full URL (we'd need to know which
   environment's base URL to prefix — dev/staging/prod), or would you rather construct it
   yourself from a base URL you already know?
3. **Response body**: do you want to return anything in the response body (e.g. a delivery ID,
   error details), or is a bare status code enough for you? We don't currently read the body at
   all.
4. **Timeout**: how long should we wait before considering a call to you timed out?
5. **SMS/WhatsApp**: when those channels are ready on your end, let us know — turning them on
   is a one-line change on our side (the flags already exist in the payload, just hardcoded
   `false` today).

---

_Source of truth for the actual call: `apps/worker/src/notification-outbound-worker.ts`'s
`dispatchOutbound` function — this doc should be kept in sync with that function if either changes._
