# Prompt: Scaffold a third-party connector

Connectors live in Phase 3. Read `docs/decisions/ADR-005-connector-sdk.md` (to be written)
and `packages/connector-sdk/` before starting.

## What a connector is

A connector bridges an external service (Slack, email, Jira, etc.) to the platform's
automation engine. It receives webhook events from the external service and translates
them into platform events, and/or receives platform automation actions and calls the
external service API.

## Security requirements (non-negotiable)

- Connector credentials stored via `@platform/secrets` (OpenBao Transit encryption)
- Webhook signatures validated before processing any payload
- SSRF protection: outbound URLs validated against tenant allowlist
- All connector actions run in BullMQ jobs — never inline in the request handler
- No connector code can read another tenant's credentials

## Template prompt

"Scaffold the [SERVICE_NAME] connector. It should:

Inbound (service → platform):

- Receive webhook at POST /connectors/[name]/webhook
- Validate [SIGNATURE METHOD] signature
- Map [SERVICE EVENT TYPES] to platform events [PLATFORM EVENT TYPES]

Outbound (platform → service):

- Handle automation action type '[action_type]'
- Call [API ENDPOINT] with [PARAMS]
- Store credentials using @platform/secrets

Create:

- `packages/connector-sdk/src/connectors/[name]/index.ts` — connector class
- `packages/connector-sdk/src/connectors/[name]/webhook.ts` — inbound handler
- `packages/connector-sdk/src/connectors/[name]/actions.ts` — outbound actions
- `packages/connector-sdk/src/connectors/[name]/types.ts` — Zod schemas for payloads
- `packages/connector-sdk/src/connectors/[name]/index.test.ts` — unit tests

All external payloads must be validated with Zod before any processing."
