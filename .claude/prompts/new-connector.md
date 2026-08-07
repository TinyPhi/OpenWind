# Prompt: Scaffold a third-party connector

Connectors live in Phase 3A, governed by
`docs/decisions/ADR-009-connector-runtime-webhook-gateway-architecture.md` (accepted
2026-08-06). Read that ADR (and `.claude/context/phase-3-primer.md` for where this fits in the
3A build sequence) before scaffolding — this note summarizes its decisions, it doesn't replace
them. v1 trust boundary is **first-party, hand-built, in-process only** — no third-party
marketplace submission yet (ADR-009 Decision #6). Read `packages/connector-sdk/` for the
current scaffold.

## What a connector is

A connector bridges an external service (email, WhatsApp Business are v1; Slack/Stripe/
QuickBooks are deferred) to the platform's automation engine via a `ConnectorDefinition`. It
receives webhook events from the external service and translates them into platform events,
and/or receives platform automation actions and calls the external service API.

## Security requirements (non-negotiable — ADR-009 Decision #5)

- Connector code never reads raw credentials: no `credentials` field on `ConnectorContext`.
  All outbound calls go through `ctx.callApi(request)`, which decrypts and attaches credentials
  server-side inside the runtime.
- `callApi()` enforces a per-connector egress allowlist (declared on the connector's
  `ConnectorDefinition`) and runs `validateWebhookUrl()` against the target on every call, not
  just at install time.
- Webhook signature verification is centralized in the gateway runtime (ADR-009 Decision #3),
  not delegated to a connector-authored `validateSignature` implementation.
- All connector actions run in BullMQ jobs — never inline in the request handler.
- No connector code can read another tenant's credentials (`connector_credentials` is
  tenant-scoped and RLS-protected; `connector_definitions` is the RLS-disabled catalog table).
- Outbound payloads are explicit field allowlists; `pii`/`financial`-classified fields require
  an explicit per-connector grant to cross the tenant boundary (ADR-009 Decision #10).

## Template prompt

"Scaffold the [SERVICE_NAME] connector. It should:

Inbound (service → platform):

- Receive webhook at `POST /webhooks/[connectorId]/{tenantId}` (the shared gateway route —
  ADR-009 Decision #3; do not add a per-connector route)
- Map [SERVICE EVENT TYPES] to platform events [PLATFORM EVENT TYPES] via the connector's
  trigger-transform, published onto the dedicated `connector-inbound` queue

Outbound (platform → service):

- Handle automation action type '[action_type]'
- Call [API ENDPOINT] with [PARAMS] via `ctx.callApi()` — never construct the request with raw
  credentials in connector code

Create:

- `packages/connector-sdk/src/connectors/[name]/index.ts` — `ConnectorDefinition`
- `packages/connector-sdk/src/connectors/[name]/webhook.ts` — trigger-transform (signature
  verification is centralized in the gateway, not here)
- `packages/connector-sdk/src/connectors/[name]/actions.ts` — outbound actions via `ctx.callApi()`
- `packages/connector-sdk/src/connectors/[name]/types.ts` — Zod schemas for payloads
- `packages/connector-sdk/src/connectors/[name]/index.test.ts` — unit tests

All external payloads must be validated with Zod before any processing."
