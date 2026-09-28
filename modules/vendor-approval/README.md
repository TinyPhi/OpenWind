# Vendor Approval Module

Config-only module (seed SQL, zero TypeScript) for a sequential, multi-department vendor
approval chain:

`draft → it_security_review → legal_review → pending_final_approval → approved`, with a
comment-required `→ rejected` exit from each review stage.

Source spec: `docs/specs/vendor-approval.md` (issue #606, 3H Phase 1). Registered
`category: "optional"` (ADR-005), so it is never auto-installed. Install it from the Templates
page or with `ModuleService.installModule(tenantId, "vendor-approval")`.

## Required setup before use

### 1. Department roles (once per Zitadel project)

Each review stage is gated by a Zitadel **project** role, with `admin` as the override:

| Stage                    | Role               |
| ------------------------ | ------------------ |
| `it_security_review`     | `it_security`      |
| `legal_review`           | `legal`            |
| `pending_final_approval` | `finance_approver` |

- **Dev:** `pnpm bootstrap` creates all three roles and three approver users (`itSecurity`,
  `legal`, `financeApprover`, same demo password as the other seed users).
- **Servers:** create the three roles once in the Zitadel console (Projects → the platform
  project → Roles, group `department`). Project roles are platform-wide, so every tenant's
  role picker lists them.
- **Grant approvers `agent` as well as their department role.** The entity routes require
  `admin`/`agent`/`user`, and admin-ui treats anyone without `admin`/`agent` as a customer.
  A department role on its own is not a supported configuration.

### 2. Notification recipients (per tenant)

`003_automation_rules.sql` seeds one notify rule per review stage, **disabled and with no
recipient**. `NotifyConfig` only accepts a fixed user id, and seed SQL can't know which user
holds a role in a given tenant. Role-based recipients are deferred to #607 (spec §D1). To turn
a rule on, open Automations, set the rule's `recipientId` to the approver's user id, and enable
it.

Each rule's condition also pins `entityTypeId` to this tenant's vendor type. The automation
executor ignores `trigger_config`, so without that pin a bare `toState` condition would fire for
any entity type with a same-named state.

### 3. Don't re-run the seed on a tenant with live vendors

`002_workflow.sql` deletes and re-inserts the workflow's states and transitions with new
ids, the same pattern as tender. Install is guarded by `installed_modules`, so this only
happens if that marker is cleared by hand. If it is, any vendor mid-workflow keeps pending
SLA timers and events that reference the old state ids, and those are not re-resolved.
Don't force a re-seed on a tenant with active vendors.

## Demo data

`apps/api/src/scripts/vendor-approval-demo.ts` installs the module on a tenant (dev tenant by
default), optionally wires notify recipients, and creates seven vendors — one at every state, plus a second rejection at the Legal stage — with
generated attachments stored through `@platform/files`. It is idempotent and resumable: the install short-circuits,
vendors are keyed on `external_ref`, and an existing vendor continues from its current state.
A run that fails partway is completed by the next run. Run it inside `ow-backend` so it shares
the API's DB, Redis and file storage. Rebuild the image first if it predates this module:

```bash
docker compose build ow-backend && docker compose up -d ow-backend
docker compose exec ow-backend pnpm exec tsx apps/api/src/scripts/vendor-approval-demo.ts \
  --notify it_security=<userId> --notify legal=<userId> --notify finance_approver=<userId>
```

Vendors enter through one seam: `VendorPayloadSchema` + `mapVendorPayload` in
`apps/api/src/scripts/vendor-approval-payload.ts`. The fixtures in
`apps/api/src/scripts/fixtures/vendor-approval.json` are synthetic (`source: "synthetic-demo"`).
Swapping in a real external source (#634) replaces only the caller of that mapping. The entity
type, workflow and rules stay unchanged.

## Walking a vendor through by hand

1. As any agent, create a Vendor. Before submitting, fill contact email, annual spend,
   justification and the security questionnaire.
2. Log in as `itSecurity` → Approve Security (or Reject, with a comment).
3. As `legal`, attach the contract draft → Approve Legal.
4. As `financeApprover` → Approve Vendor.

A user without the stage's department role doesn't see that stage's buttons. If they call the
API directly, they get `TRANSITION_FORBIDDEN`.
