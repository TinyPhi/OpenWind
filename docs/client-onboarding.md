# Client onboarding: what OpenWind must have in place

> **ENGINEERING / COMPLIANCE WORKING DRAFT. NOT LEGAL ADVICE. NOT YET LEGALLY REVIEWED.** This page
> was written by engineering from the repository, not by a lawyer. Qualified counsel (EU/UK and
> India data-protection) must review it, and the contract templates it points to, **before the
> first paying EU, UK or India customer**. Where a value is unknown it is a `TBD` placeholder.
> Nothing here invents a contact, a legal entity, a fee, a date or a legal conclusion. Technical
> statements were checked against the repository on 2026-10-31; anything that could not be checked
> is marked **UNVERIFIED**.

## 1. Purpose, how to use it, owner

**Purpose.** A single place that answers: when a client (a "customer") is about to sign, what must
OpenWind already have decided, signed, registered and configured?

**Audience.**

- The owner/founder, who acts as their own compliance lead (there is no DPO and no in-house lawyer).
  Sections 2 to 7, 9, 10 and 11 are written for this reader. Read the "Why" and "Who decides"
  columns first.
- Engineers who provision tenants. Section 8 is the runbook-style checklist, with a pointer to the
  code or doc for each step.

**How to use it.**

1. Copy the checklists in sections 3, 8, 9 and 10 into the customer's onboarding ticket. Do not
   put customer specifics into this file (see [section 6](#6-registers)).
2. Work top to bottom. A box is ticked only when the evidence (a signed file, a register entry, a
   config value) exists and is filed where section 6 says.
3. Anything that needs a legal judgement goes to counsel. This page lists the question, not the
   answer.
4. When something here turns out wrong or changes, fix this page in the same change.

**Status banner for each section.** "Verified" means checked against code or a repo doc on the date
above. "UNVERIFIED" means not checked. "Counsel" means a legal decision.

| Item                               | Value                      |
| ---------------------------------- | -------------------------- |
| Owner of this document             | `TBD: not decided`         |
| Legal / compliance reviewer        | `TBD: not decided`         |
| Date of last legal review          | `TBD: never reviewed`      |
| Review cadence once approved       | `TBD: suggest yearly`      |
| Where customer-specific files live | `TBD: not decided` (see 6) |
| Contract templates folder          | `TBD: not decided` (see 4) |

Related docs: [breach notification runbook](runbooks/breach-notification.md) (same placeholder
convention, same hosted/self-hosted framing), [runbooks index](runbooks/README.md),
[deployment hardening](deployment-hardening.md), [backup and DR](specs/backup-dr-runbook.md),
[ADR-001](decisions/ADR-001-multitenancy.md), [ADR-005](decisions/ADR-005-module-optionality-and-tender.md),
[ADR-015](decisions/ADR-015-observability-compliance.md),
[ADR-023](decisions/ADR-023-openbao-secrets-manager.md).

## 2. Roles: who is controller and who is processor

The legal role depends on how the customer runs OpenWind. This is the same framing as the
[breach runbook](runbooks/breach-notification.md).

| Deployment  | Customer role                     | OpenWind role                                                                                      | Consequence                                                                                      |
| ----------- | --------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Hosted      | **Controller** of tenant data     | **Processor**, acting only on the customer's documented instructions (GDPR Art. 28)                | A DPA is required. Sub-processors, transfers and breach duties apply (sections 4 and 7).         |
| Self-hosted | Controller **and** runs the infra | Software vendor. A processor **only** for what OpenWind does itself, such as remote support access | A DPA is needed only if OpenWind ever touches the data (support access, hands-on migration, AI). |

"Tenant data" means everything the customer's users put into their tenant: tickets, comments,
attachments, CRM, HRMS, reimbursement and other module records, user directory data, org chart.

### OpenWind as controller of its own data

Even when it is only a processor for tenant data, OpenWind decides the purpose and means for the
following, so it is a **controller** for them. Each needs a basis and a notice (see section 7).

| Processing OpenWind controls             | What it is                                                                                                                                                | Verified in repo                                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Customer account and billing contacts    | Names, work emails, phone, invoicing details of the customer's commercial contacts. Lives in OpenWind's own business systems, not the platform            | UNVERIFIED: no billing system is described in the repo. `tenants.plan` exists but holds no billing data    |
| Security and audit logs                  | `admin_audit_log` (append-only, redacted snapshots), `workflow_events`, third-party API access logs, application, proxy and database logs                 | Verified: [breach runbook](runbooks/breach-notification.md), ADR-015                                       |
| Telemetry and error tracking             | Prometheus metrics, OTel traces, and error events if `ERROR_TRACKING_PROVIDER` is set. Default is `none`. PII scrubbing is applied before an event leaves | Verified: `packages/config/src/env.ts` (`ERROR_TRACKING_PROVIDER` default `none`), breach runbook, ADR-015 |
| Support access to a customer environment | Remote access, screen sharing, a copy of data for debugging, support tickets that quote customer data                                                     | UNVERIFIED: no support-access procedure exists in the repo. Decide one (open question 6)                   |
| Usage metering                           | `tenant_usage_daily`: per-tenant API calls, storage bytes, AI tokens. Counts, not content                                                                 | Verified: ADR-015 Decision 3, `apps/worker/src/usage-metering.ts` exists                                   |
| Sales, marketing and website             | Prospect contacts, website analytics and cookies, demo requests                                                                                           | Out of scope of the platform. Needs a privacy notice and ePrivacy/cookie review (counsel)                  |
| Sandbox trials for prospects             | A sandbox tenant has seeded synthetic users and data and is for demos. A prospect's own staff log in with generated accounts                              | Verified: [multi-org sandbox spec](specs/multi-org-sandbox.md) (status `draft`), ADR-022 (Proposed)        |

## 3. Pre-contract checklist

Do this before sending a draft contract. The output is a one-page **customer intake record**
filed in the customer folder (section 6), not in this repo.

| #    | Check                                          | Why it matters                                                                                                                                                                                                                                                                   | Who decides                        | Done |
| ---- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---- |
| 3.1  | Customer qualification                         | Legal entity, country, sector, size, sanctions and conflict check, whether a regulated sector (health, finance, public sector)                                                                                                                                                   | Owner; counsel if regulated        | [ ]  |
| 3.2  | Deployment model: hosted or self-hosted        | Decides OpenWind's role (section 2) and whether a DPA is needed                                                                                                                                                                                                                  | Owner with the customer            | [ ]  |
| 3.3  | Data categories to be processed                | Drives the DPA annex, the RoPA, the DPIA screen and the module list                                                                                                                                                                                                              | Customer states, owner confirms    | [ ]  |
| 3.4  | **Special-category and sensitive data screen** | Art. 9 data (health, union membership, religion, ethnicity, biometrics and similar), criminal-offence data (Art. 10), children's data. HRMS and reimbursement modules can hold health, bank and identity data                                                                    | Owner; counsel if any "yes"        | [ ]  |
| 3.5  | Whose data subjects                            | Employees, customers, suppliers, public. Employees raise works-council and employment-law questions in some countries                                                                                                                                                            | Owner; counsel                     | [ ]  |
| 3.6  | Data residency and transfer needs              | Where the customer's data subjects are, where they want data stored, whether a transfer mechanism is needed (section 4.4). **Regional hosting is not a built feature**: the platform is one shared Postgres schema; ADR-015 defers "data residency / regional Postgres clusters" | Owner; counsel                     | [ ]  |
| 3.7  | Modules wanted                                 | Core modules are installed automatically on every new tenant (section 8.4), including HRMS. Decide whether to hide (uninstall) what the customer will not use; this does not delete seeded data                                                                                  | Owner with the customer            | [ ]  |
| 3.8  | SSO and identity provider                      | The platform signs in through Zitadel (section 8.2). Customer-side IdP federation is not described in the repo: **UNVERIFIED**                                                                                                                                                   | Engineering                        | [ ]  |
| 3.9  | Volumes and retention expectations             | Users, tickets per month, attachment size, retention the customer expects against the sweep defaults (section 8.5)                                                                                                                                                               | Customer states, engineering sizes | [ ]  |
| 3.10 | **AI features: opt in or out (3C)**            | 3C is not started. No application code calls `packages/ai` today (verified by search of `apps/` and `packages/`). If the customer wants AI later, it is a separate decision with its own addendum (section 4.10)                                                                 | Owner; counsel                     | [ ]  |
| 3.11 | Required certifications or audits              | ISO 27001, SOC 2, pen-test report requests. OpenWind has none documented: **UNVERIFIED**. Do not promise                                                                                                                                                                         | Owner                              | [ ]  |
| 3.12 | Customer-side contacts collected               | See section 5.5                                                                                                                                                                                                                                                                  | Account owner                      | [ ]  |
| 3.13 | Demo or trial on synthetic data only           | A sandbox is seeded with synthetic data. Never load real personal data into a trial before a contract and DPA are in place                                                                                                                                                       | Owner                              | [ ]  |

**Stop conditions.** Do not proceed to contract if: special-category data is in scope and no DPIA
or counsel review exists; the customer needs a data location OpenWind cannot provide; or the
customer expects a certification OpenWind does not hold.

## 4. Contracts

Order of signature is in [4.14](#414-order-of-signature). For every item: **Why**, **Who
decides**, **OpenWind needs ready**, **Template path**. All template paths are `TBD` until counsel
produces them. Counsel is the decider for every legal wording; the owner decides commercial terms.

### 4.1 Master services agreement or terms of service

- **Why:** the umbrella for scope, term, payment, IP, warranties, liability, termination.
- **Who decides:** owner (commercial), counsel (legal).
- **OpenWind needs ready:** the contracting legal entity (`TBD: entity name`), governing law and
  forum (`TBD`), licence position. The code is AGPL-3.0 (`LICENSE`); a hosted service and any
  commercial or dual licence need counsel's view on how the terms sit with the licence (open
  question 9).
- **Template path:** `TBD`.

### 4.2 Order form

- **Why:** per-customer commercial specifics: plan (`standard`, `professional` or `enterprise`,
  verified in `ProvisionTenantSchema`), modules, user counts, term, fees, support tier, region,
  sub-processors in force at signing.
- **Who decides:** owner. **Fees, term and dates:** `TBD`, never copied from another customer.
- **Template path:** `TBD`.

### 4.3 Data processing agreement (DPA), GDPR Art. 28(3)

Required for **hosted** deployments (and for self-hosted where OpenWind touches data). It must be
binding and in writing. The clauses below are the Art. 28(3) minimum. Counsel drafts the wording.

| #     | Required clause (Art. 28(3))                                                                    | What it means for OpenWind                                                                                                                             | What the platform supports today                                                                                                                     |
| ----- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.3.a | Process only on **documented instructions** (including for transfers)                           | The DPA plus order form plus the customer's admin actions are the instructions. OpenWind must tell the customer if an instruction breaks the law       | Tenant admin actions are audit-logged (`admin_audit_log`). Role and permission change auditing is tracked in #640: check status before relying on it |
| 4.3.b | **Confidentiality** of everyone authorised to process                                           | Staff and contractor confidentiality terms; need-to-know access                                                                                        | Platform roles `admin`, `agent`, `user` (Zitadel). Staff NDAs and training are a people process (register 6.8): `TBD`                                |
| 4.3.c | **Security measures** (Art. 32)                                                                 | Attach the security schedule (4.6)                                                                                                                     | RLS tenant isolation (ADR-001), IP allowlist, rate limits, encryption in transit and at rest are deployer controls (deployment hardening)            |
| 4.3.d | **Sub-processors**: prior authorisation (specific or general) and flow-down                     | General authorisation with a list and a notice period for changes, and a customer right to object. Same obligations flow to each sub-processor         | List in 4.5. Notice mechanism: `TBD` (email list or a status page)                                                                                   |
| 4.3.e | **Assistance with data-subject requests** (Chapter III)                                         | Help the controller respond to access, portability, erasure and the rest, within a stated time                                                         | Per-user export `POST /users/:userId/export` (admin only), per-user erasure `DELETE /users/:userId` (admin only), tenant purge. See section 7.5      |
| 4.3.f | **Assistance** with Art. 32 to 36: security, **breach notification**, DPIAs, prior consultation | Notify the controller without undue delay after becoming aware (Art. 33(2)). A contractual hour limit is a commercial decision (4.12). Help with DPIAs | Breach runbook, processor notice template, breach register. Known detection gaps (#640, #641) are listed there: do not over-promise                  |
| 4.3.g | **Deletion or return** of all personal data at the end of the services                          | The customer chooses delete or return. Existing copies are deleted unless law requires storage                                                         | Tenant delete then purge job (default 30 days, minimum 1). Export tooling. Backup copies persist until backup expiry (section 10)                    |
| 4.3.h | Make available **all information to show compliance** and allow **audits**                      | Audit rights: scope, notice, frequency, cost, confidentiality, and whether a third-party report can satisfy them                                       | Audit log export, RoPA, this page. No certification exists to hand over: **UNVERIFIED**                                                              |

Also include in the DPA, even though Art. 28(3) does not list them as numbered items: the subject
matter, duration, nature and purpose of processing, types of personal data and categories of data
subject (an annex, filled per customer from the intake in section 3), the customer's obligations
as controller, liability allocation (4.9), and which law and courts govern.

- **Who decides:** counsel drafts, owner approves commercial positions.
- **Template path:** `TBD`.

### 4.4 International transfer mechanism

| Case                                                    | Mechanism to have ready                                                                                                                                | Notes                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| EU/EEA customer data accessed or hosted outside the EEA | EU adequacy decision where one exists, otherwise **Standard Contractual Clauses** (SCCs) plus a transfer impact assessment                             | Which module of the SCCs applies depends on the roles of each party (counsel). Remote support access from outside the EEA is itself a transfer |
| UK customer data                                        | UK adequacy regulations, or the **UK International Data Transfer Agreement** or the **UK Addendum** to the SCCs                                        | Counsel                                                                                                                                        |
| Transfers out of India, or inbound data from India      | DPDP Act 2023 cross-border rules (the Act permits transfers except to countries the government restricts by notification; sector laws may be stricter) | **UNVERIFIED** and counsel decides. Do not state the current restricted-country list; check it at signing                                      |
| Transfers to sub-processors (4.5)                       | Each sub-processor's own mechanism, recorded in the transfer register (6.4)                                                                            | Hosting location of OpenWind's production environment: `TBD: not recorded in repo`                                                             |

- **Why:** a transfer without a valid mechanism is unlawful for the customer and for OpenWind.
- **Who decides:** counsel. **Owner:** decide where production is hosted (open question 3).
- **Template path:** `TBD` (SCCs, UK addendum, transfer impact assessment).

### 4.5 Sub-processor list and schedule

The DPA schedule names each sub-processor, its location and what it does. Derived below from the
repo. "Used in hosted deployment" is **not** knowable from the repo: the owner fills it in.

| Category                                                       | Component in repo                                                                                                                                                          | Receives customer personal data?                                                                                     | Verified                                                                                                                                                                  | Used in hosted deployment |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Infrastructure hosting (servers, storage, backups)             | Postgres, Redis, local-disk file storage, backup destination                                                                                                               | Yes, everything. Provider and region are the deployer's choice                                                       | Verified architecture ([deployment hardening](deployment-hardening.md)). Provider: not in repo                                                                            | `TBD: provider, region`   |
| Identity provider                                              | Zitadel, a separate compose project (`../zitadel/`). Holds user names, emails, org metadata (manager, department)                                                          | Yes: user identity and directory data                                                                                | Verified ([local setup](local-setup.md)). Whether OpenWind runs it or a vendor hosts it: UNVERIFIED (a hardening note mentions "the hosted Zitadel this deployment uses") | `TBD`                     |
| Notification orchestration                                     | Novu, self-hosted containers under the `notifications` profile (`novu-api`, `novu-worker`, `novu-web`, `novu-mongo`)                                                       | Yes: recipient and message content                                                                                   | Verified in `docker-compose.yml`. Self-run, so not a third party unless a managed Novu is used                                                                            | `TBD`                     |
| Email / SMS / WhatsApp / voice delivery                        | An outbound delivery service OpenWind calls via `NOTIFICATION_SERVICE_URL` ([contract](notification-outbound-contract.md)). Providers such as an SMS carrier sit behind it | Yes: recipient address or number and message text                                                                    | Contract doc verified (status draft). **Actual provider UNVERIFIED**                                                                                                      | `TBD`                     |
| Error tracking                                                 | Sentry-protocol provider (`sentry`, `glitchtip`, `bugsink`), off by default (`none`)                                                                                       | Possibly, after PII scrubbing (`beforeSend`)                                                                         | Verified (`env.ts`, ADR-015, breach runbook)                                                                                                                              | `TBD: on or off`          |
| Observability backend                                          | Prometheus, Grafana, Alertmanager, OTel collector (`observability` profile), self-hosted by default                                                                        | Metrics and traces: designed to carry no payloads (ADR-015). Logs may carry identifiers                              | Verified compose profile and ADR-015                                                                                                                                      | `TBD`                     |
| Reporting                                                      | Apache Superset, `reporting` profile, with its own database (saved queries, query history, accounts when Stage 2 is on)                                                    | Yes when on. Stage 2 stays off pending review ([ADR-019](decisions/ADR-019-reporting-tenant-isolation.md), Proposed) | Verified. See [Superset erasure runbook](runbooks/superset-erasure.md)                                                                                                    | `TBD`                     |
| Virus scanning                                                 | ClamAV container, local                                                                                                                                                    | File bytes, processed locally                                                                                        | Verified in `docker-compose.yml`. Not a third party                                                                                                                       | n/a                       |
| Secrets                                                        | OpenBao, a separate server in production (ADR-023, Proposed)                                                                                                               | Connector credential ciphertext, not business data                                                                   | Verified                                                                                                                                                                  | `TBD`                     |
| AI model provider (3C)                                         | `packages/ai` wraps the Anthropic SDK. Needs `ANTHROPIC_API_KEY`, which is optional                                                                                        | Would receive prompts built from tenant data **if** a 3C feature existed                                             | Verified: no `apps/` or other package imports `@platform/ai`, so **no data flows today**                                                                                  | None until 3C ships       |
| Payment, accounting, CRM, support desk used by OpenWind itself | Not in repo                                                                                                                                                                | Customer contact data (controller activity, section 2)                                                               | UNVERIFIED                                                                                                                                                                | `TBD`                     |

**Notice of change.** Decide how customers are told of a new sub-processor and how long they have
to object (`TBD`, commonly 30 days: counsel). Keep the list in the sub-processor register (6.2).

### 4.6 Security schedule (Art. 32)

Attach to the DPA. Map each control to its evidence. Be honest about what is the deployer's.

| Control area                            | Commitment OpenWind can make (verified)                                                                                                                                    | Evidence                                                                                 | Gap or caveat                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation                        | Shared schema with Postgres row-level security plus an explicit `tenant_id` filter in engine queries. Cross-tenant access returns 404                                      | ADR-001; `tests/isolation/`                                                              | Mistakes in RLS or a tenant filter are a SEV1 breach class                                                                                    |
| Authentication, roles                   | Zitadel OIDC, JWT validation, roles `admin`, `agent`, `user`; live token introspection on sensitive operations                                                             | `packages/auth`, `scripts/bootstrap.ts`, [deployment hardening](deployment-hardening.md) | Role-change auditing: #640                                                                                                                    |
| Network and transport                   | TLS 1.2 and 1.3 at the reverse proxy, HTTP to HTTPS redirect, HSTS, internal services not public                                                                           | [Deployment hardening](deployment-hardening.md) (deployer-owned controls)                | The application cannot enforce TLS alone                                                                                                      |
| Encryption at rest                      | Volume or disk encryption for Postgres, files, Zitadel DB, OpenBao, logs and **backups**                                                                                   | Deployment hardening, "Encryption at rest"                                               | **Not done by OpenWind's containers.** `scripts/backup.sh` does not encrypt. Must be set up and evidenced                                     |
| Secrets                                 | OpenBao Transit for connector credentials; hashed API keys; per-service AppRoles; production refuses dev secrets                                                           | ADR-023, [OpenBao runbook](runbooks/openbao-secrets.md), deployment hardening            | ADR-023 is Proposed                                                                                                                           |
| Access restriction                      | Per-tenant `ip_allowlist` in `tenants.config`; per-tenant `rate_limit_per_min`; platform-operator fence (`PLATFORM_ORG_ID`); superadmin routes return 404 to non-operators | `packages/auth/src/middleware.ts`, `apps/api/src/lib/platform-operator.ts`, ADR-013      | `PLATFORM_ORG_ID` must be set in production or the admin routes refuse everyone                                                               |
| Logging and audit                       | Append-only `admin_audit_log`; export audit trail; API key lifecycle with revocation records                                                                               | `@platform/audit`, [export audit trail](specs/export-audit-trail.md), ADR-008            | No alerting on login failures or RLS-denial bursts (#641)                                                                                     |
| Malware                                 | Async ClamAV scan of uploads                                                                                                                                               | `apps/worker/src/av-scan.ts`                                                             |                                                                                                                                               |
| Backup and recovery                     | Nightly backup target, **24 hour RPO**, restore procedure tested once, **no committed RTO**. DB backup and OpenBao snapshot are one set                                    | [Backup and DR](specs/backup-dr-runbook.md); deployment hardening                        | No point-in-time recovery, no per-tenant selective restore, no off-host copy by default. T7 (OpenBao restore test) was open when last checked |
| Vulnerability and dependency management | Pinned security overrides with advisories documented                                                                                                                       | `pnpm-workspace.yaml` overrides                                                          | No formal patch SLA documented: `TBD`                                                                                                         |
| Personnel                               | Confidentiality, training, access reviews                                                                                                                                  | Registers 6.7 and 6.8                                                                    | Process not yet defined: `TBD`                                                                                                                |
| Certifications                          | None documented                                                                                                                                                            | n/a                                                                                      | UNVERIFIED. Never claim "GDPR compliant" or a certification                                                                                   |

### 4.7 SLA and support

- **Why:** sets availability, response and restore expectations. The platform has no committed
  RTO and a 24 hour RPO, so do **not** offer a stricter SLA than the infrastructure can meet.
- **Who decides:** owner. Figures: `TBD: availability %, response times, support hours, severity
definitions`. Severity levels exist in the product (3E) but customer SLA terms are not defined.
- **OpenWind needs ready:** a support intake channel (`TBD`), an escalation path, a status
  communication route, and a rule for support access to customer data (section 2).
- **Template path:** `TBD`.

### 4.8 Acceptable use policy and NDA

- **AUP:** what customers may not do (illegal content, abuse of the API, security testing without
  consent, special-category data where the order form excludes it). Counsel; owner approves.
  Template `TBD`. Rate limits and per-tenant suspension (`active` to `suspended`) are how it is
  enforced technically.
- **NDA:** mutual, before technical or commercial detail is shared. Owner decides. Template `TBD`.

### 4.9 Liability and indemnity (counsel decides)

Do not agree these without counsel. Questions to settle:

- Liability cap and exclusions, including whether data-protection breaches are inside or outside
  the cap (a super-cap is common).
- Who bears regulator fines and data-subject claims, and what "caused by the processor"
  means (Art. 82).
- Indemnity for IP claims, for the customer's unlawful instructions, and for the customer's
  content.
- Insurance needed (cyber, professional indemnity): `TBD`.

### 4.10 AI and data-use addendum (3C)

3C is **not started**, and [ADR-018](decisions/ADR-018-ai-layer.md) is a draft. No application
code calls the AI client, so today no tenant data goes to a model provider. Because that may
change, the contract should already say:

- AI features are **off unless the customer opts in in writing**.
- Which provider and region, as a sub-processor, with its own transfer mechanism.
- No training on customer data; provider-side retention bounded. ADR-018 open question OQ-6 says
  nobody has yet read the provider's current terms: **UNVERIFIED**. Do this before any 3C feature
  touches real data.
- Who holds the provider key: OpenWind (then OpenWind is a processor with a sub-processor) or the
  customer (self-hosted: the customer's own relationship). This is an owner decision.
- A tenant-level switch to disable AI entirely: not found in the repo (ADR-018 only describes the
  gateway returning `AI_DISABLED` when no provider key is set): **UNVERIFIED**.

Template path: `TBD`.

### 4.11 Breach notification clause

Align with the [breach runbook](runbooks/breach-notification.md): OpenWind notifies the customer
**without undue delay** after becoming aware (Art. 33(2)); the customer's 72 hours start when the
customer becomes aware. Decide the contractual outer limit in hours (`TBD`, counsel and owner),
the notice channel (`TBD`), and the named customer breach contact (section 5.5). Do not promise a
shorter limit than the runbook can meet: its owners, intake channel and detection are still `TBD`
and detection gaps exist (#640, #641). Include what the notice contains (runbook Template 1) and
that OpenWind does not notify authorities or data subjects for the customer unless asked.

### 4.12 Retention and exit terms

- Data return format and time window; deletion timeline after termination; what is kept (audit
  log, legal-hold data) and why; backup expiry (section 10).
- The platform facts to reflect: tenant deletion is scheduled with a delay (default 30 days,
  minimum 1, maximum 365) and then a purge job hard-deletes the tenant's data. Deletion cannot be
  undone after the purge. Retention windows default to 90 days (noise), 365 (comments) and 2555
  (evidence) and are overridable per tenant (section 8.5).
- **Who decides:** owner and counsel. **Template path:** `TBD`.

### 4.13 Other items to have ready

| Item                                         | Why                                                             | Decider | Template path |
| -------------------------------------------- | --------------------------------------------------------------- | ------- | ------------- |
| Privacy notice (OpenWind as controller)      | Needed for account contacts, website and sales (section 7.2)    | Counsel | `TBD`         |
| Customer-facing security summary             | Honest one-pager that mirrors section 4.6                       | Owner   | `TBD`         |
| Data subject request procedure for customers | What a customer admin does and what OpenWind does (section 7.5) | Owner   | `TBD`         |
| Self-hosted support addendum                 | If OpenWind ever gets access to a customer-run environment      | Counsel | `TBD`         |

### 4.14 Order of signature

1. Mutual NDA (before detailed technical or commercial sharing).
2. Order form and MSA/terms, with the AUP, SLA and security schedule attached.
3. **DPA**, with the sub-processor schedule, transfer mechanism and AI addendum. **Signed before any
   real personal data is loaded.** Never load production data on the strength of the MSA alone.
4. Customer-side contact sheet (section 5.5) and the customer's written confirmations (section
   7.1).
5. Then provisioning (section 8). The go-live gate (section 9) re-checks that 1 to 4 are filed.

## 5. Representatives and named contacts

### 5.1 EU representative (GDPR Art. 27)

- **Rule:** a controller or processor **not established in the EU** that offers goods or services
  to people in the EU, or monitors their behaviour, must appoint a representative in the EU
  (Art. 27). The exemption is occasional processing that is not large-scale, does not involve
  special-category or criminal data at scale, and is unlikely to risk people's rights. Public
  authorities are exempt.
- **How to decide:** (1) where is the contracting entity established? `TBD: entity and country`.
  If it has an EU establishment, Art. 27 does not apply but a lead authority question does.
  (2) Is OpenWind itself "offering services" to EU people, or only to EU businesses? For a
  processor, the question is whether the processing relates to targeting EU data subjects; counsel
  decides. (3) Is the processing occasional? A recurring hosted service is unlikely to be.
- **If required:** appoint in writing, name them in the privacy notice and in the DPA, and give
  them the register. Representative: `TBD: not appointed`.

### 5.2 UK representative (UK GDPR Art. 27)

Same test for the UK. If OpenWind is not established in the UK and serves UK data subjects, a UK
representative may be needed. `TBD: not appointed`. Counsel decides.

### 5.3 India: DPDP Act 2023

- The Act applies to processing in India and to processing outside India connected to offering
  goods or services to people in India. As far as known it has **no resident-representative
  rule like Art. 27**: **UNVERIFIED**, counsel to confirm against the Act and the rules in force.
- Roles map differently: the controller is the **Data Fiduciary** and the processor is the **Data
  Processor**, and the fiduciary stays accountable. A processor is engaged under a valid contract.
- A **Significant Data Fiduciary** (designated by the government) has extra duties: a data
  protection officer based in India, an independent data auditor and periodic impact assessments.
  Whether OpenWind or a customer is designated is not known: **UNVERIFIED**.
- A **grievance redressal contact** must be published by a fiduciary. For OpenWind as fiduciary of
  its own data: `TBD: name and channel`. For the customer: collected in 5.5.
- Counsel must confirm commencement dates and what is in force, because the rules phase in.

### 5.4 Data protection officer (GDPR Art. 37)

- **When required:** public authorities; core activities needing large-scale regular and
  systematic monitoring of people; core activities of large-scale special-category or criminal
  data. Customers in those groups need their own DPO.
- **OpenWind position today:** there is **no DPO** and none is currently believed to be required
  for a small processor, **counsel to confirm** before the first paying EU customer. The role of
  privacy contact is held by `TBD: named person`. Do not call anyone "DPO" unless formally
  designated. The owner must not be put in a DPO role where it conflicts with deciding the
  purposes of processing (Art. 38(6)).
- **Customer's DPO:** collect their contact (5.5). Where the customer has none, record that.

### 5.5 Customer-side contacts to collect

| Contact                                    | Used for                                       | Value                    |
| ------------------------------------------ | ---------------------------------------------- | ------------------------ |
| Controller contact (legal entity, address) | DPA parties, notices                           | `TBD: from customer`     |
| Contract and commercial owner              | Order form, renewals                           | `TBD: from customer`     |
| Security contact                           | Vulnerabilities, key and access issues         | `TBD: from customer`     |
| **Breach contact (24x7 route)**            | Processor breach notice (runbook Template 1)   | `TBD: from customer DPA` |
| Customer DPO or privacy lead               | Data-subject requests, DPIA, audits            | `TBD: from customer`     |
| Tenant admin(s)                            | People who hold the `admin` role in the tenant | `TBD: from customer`     |
| Grievance officer (India)                  | DPDP grievances where relevant                 | `TBD: from customer`     |

### 5.6 OpenWind-side named roles

All are `TBD: not decided`. They tie to the open facts in the [breach
runbook](runbooks/breach-notification.md) and to [#639](../issues/639).

| Role                                   | Responsibility                                                               | Person |
| -------------------------------------- | ---------------------------------------------------------------------------- | ------ |
| Privacy contact (acts in the DPO role) | Data-subject requests, DPA questions, registers, regulator contact           | `TBD`  |
| Security lead                          | Controls in 4.6, access reviews, vulnerability handling                      | `TBD`  |
| Breach owner (incident commander)      | Runs the breach runbook, owns the 72-hour clock                              | `TBD`  |
| Legal / compliance reviewer            | Approves external notices and contract changes                               | `TBD`  |
| Customer account owner                 | Relationship, sends processor notices                                        | `TBD`  |
| Platform operator(s)                   | Hold `superadmin` in the operator org (`PLATFORM_ORG_ID`); provision tenants | `TBD`  |

## 6. Registers

**Where they live.** Registers that hold customer specifics (customer names, counts, contacts,
incident detail) do **not** belong in this public repository. Keep them in a restricted, backed-up
location with access logging (`TBD: not decided`). Only the empty templates below are suitable for
the repo. Registers must not contain personal data of data subjects. The platform's own records
(audit log, usage metering) are inputs to the registers, not substitutes.

| #    | Register                                     | Owner | Review cadence                   | What the platform already records                                                                                                                      |
| ---- | -------------------------------------------- | ----- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6.1  | Record of processing activities (Art. 30(2)) | `TBD` | Yearly and on any change         | Nothing automatic. Module list per tenant in tenant config. Tenant lifecycle audit actions                                                             |
| 6.2  | Sub-processor register                       | `TBD` | Quarterly, and before any change | Nothing                                                                                                                                                |
| 6.3  | DPA and contract register                    | `TBD` | Quarterly                        | Nothing                                                                                                                                                |
| 6.4  | Transfer register                            | `TBD` | Yearly and on any change         | Nothing                                                                                                                                                |
| 6.5  | Breach and incident register (Art. 33(5))    | `TBD` | Per incident; yearly review      | Audit log, export audit entries. Fields defined in the [breach runbook](runbooks/breach-notification.md#breach-register-art-335)                       |
| 6.6  | Data-subject request and erasure log         | `TBD` | Monthly                          | Audit actions `deleted` and `purge.completed`; `export.requested`, `export.completed`, `export.downloaded`; `superset_erasure.completed` and `.failed` |
| 6.7  | DPIA register                                | `TBD` | Per processing change            | Nothing                                                                                                                                                |
| 6.8  | Access and privilege review log              | `TBD` | Quarterly                        | `tenant_users`, Zitadel role grants, API key records with `revoked_at`. Role-change auditing is #640                                                   |
| 6.9  | Retention schedule                           | `TBD` | Yearly                           | Per-tenant policy snapshots in `admin_audit_log` on every retention change                                                                             |
| 6.10 | Training log                                 | `TBD` | Yearly                           | Nothing                                                                                                                                                |

### 6.1 Record of processing activities (processor), Art. 30(2)

Required of each processor (small-organisation relief rarely applies where processing is not
occasional or includes special categories). One record per **controller** the processor acts for.
Exact fields:

1. Name and contact details of the **processor** (and its representative and DPO, if any), and of
   **each controller** the processor acts for (and their representative and DPO).
2. The **categories of processing** carried out on behalf of each controller.
3. **Transfers** to a third country or international organisation, with the identification of
   that country or organisation and, where relied on, the documentation of suitable safeguards.
4. A general description of the **technical and organisational security measures** (Art. 32(1)).

Table template:

| Controller (name, contact, DPO) | Categories of processing                | Transfers (country, safeguard) | Security measures (ref)  | Sub-processors (ref) | DPA ref | Last reviewed |
| ------------------------------- | --------------------------------------- | ------------------------------ | ------------------------ | -------------------- | ------- | ------------- |
| `TBD`                           | `TBD: e.g. hosting of helpdesk records` | `TBD`                          | Section 4.6 of this page | Register 6.2         | `TBD`   | `TBD`         |

OpenWind's **own** controller activities (section 2) need a separate Art. 30(1) record with:
purposes, categories of data subjects and data, recipients, transfers, retention periods, and the
security description.

### 6.2 Sub-processor register

| Sub-processor | Service | Data categories | Location | Transfer mechanism | DPA signed (date) | Added on | Customers notified (date) | Removed on |
| ------------- | ------- | --------------- | -------- | ------------------ | ----------------- | -------- | ------------------------- | ---------- |
| `TBD`         | `TBD`   | `TBD`           | `TBD`    | `TBD`              | `TBD`             | `TBD`    | `TBD`                     | `TBD`      |

### 6.3 DPA and contract register

| Customer | Contract set (NDA, MSA, order form, DPA, SLA, AUP) | Signed on | Term and renewal | DPA version | Sub-processor list version at signing | Owner |
| -------- | -------------------------------------------------- | --------- | ---------------- | ----------- | ------------------------------------- | ----- |
| `TBD`    | `TBD`                                              | `TBD`     | `TBD`            | `TBD`       | `TBD`                                 | `TBD` |

### 6.4 Transfer register

| Data flow | From  | To    | Mechanism (adequacy, SCCs module, UK addendum, DPDP) | Transfer impact assessment ref | Supplementary measures | Reviewed |
| --------- | ----- | ----- | ---------------------------------------------------- | ------------------------------ | ---------------------- | -------- |
| `TBD`     | `TBD` | `TBD` | `TBD`                                                | `TBD`                          | `TBD`                  | `TBD`    |

### 6.5 Breach and incident register

Use the fields in the [breach runbook](runbooks/breach-notification.md#breach-register-art-335).
Its location is still an open fact there: set both to the same place. Record non-notified breaches
too.

### 6.6 Data-subject request and erasure log

| Request ID | Received (date) | From (role, not name where avoidable) | Controller | Type (access, export, erase, rectify, restrict, object) | Verified identity | Action and mechanism | Done (date) | Evidence (audit ref) | Superset follow-up |
| ---------- | --------------- | ------------------------------------- | ---------- | ------------------------------------------------------- | ----------------- | -------------------- | ----------- | -------------------- | ------------------ |
| `TBD`      | `TBD`           | `TBD`                                 | `TBD`      | `TBD`                                                   | `TBD`             | `TBD`                | `TBD`       | `TBD`                | `TBD`              |

What the platform already records, so the log can cite it instead of copying data:

- **Erasure:** the admin audit entry `deleted` (resource `user`). Per-user erasure anonymises in
  place (`[REDACTED]`) rather than deleting business records. It scrubs user references in
  entity fields, workflow events and comments, and also deletes the person's Zitadel account
  ([spec](specs/user-erasure-anonymization.md)). If Zitadel refuses, the API returns
  `502 SIGN_IN_NOT_REMOVED` and the erase must be repeated ([runbook](runbooks/superset-erasure.md)).
- **Export (Art. 15/20):** `export.requested`, `export.completed`, `export.downloaded`. The file is
  deleted after `USER_EXPORT_TTL_DAYS` (default 7). The spec header says status `in-progress`:
  confirm it is shipped before promising it to a customer ([spec](specs/user-data-export.md)).
- **Superset:** `superset_erasure.completed` or `.failed` rows, and the `SupersetErasureFailed`
  alert ([runbook](runbooks/superset-erasure.md)). `superset openwind-erase` by hand writes no audit
  row, so log who ran it and why in the incident ticket.
- **Not covered automatically:** free-text references such as "spoke to Alice" in unmentioned text
  are a manual process ([spec](specs/user-erasure-anonymization.md)). The audit log is kept
  (Art. 17(3)(b) reasoning in that spec: counsel to confirm).

### 6.7 DPIA register and when a DPIA is needed

A DPIA (Art. 35) is the **controller's** duty, and the processor helps. Screen every customer. A
DPIA is likely needed where the processing is likely to result in high risk, in particular:
systematic evaluation or profiling with significant effects, large-scale special-category or
criminal data, systematic monitoring of a public area, or a combination of the criteria national
authorities publish (new technology, vulnerable subjects such as employees or children, large
scale, matching datasets). Examples here: an HRMS tenant with health or disciplinary data, an
AI feature profiling employees, reimbursement data with bank details at scale.

| DPIA ID | Customer | Processing | Trigger | Date  | Outcome and residual risk | Prior consultation needed | Review due |
| ------- | -------- | ---------- | ------- | ----- | ------------------------- | ------------------------- | ---------- |
| `TBD`   | `TBD`    | `TBD`      | `TBD`   | `TBD` | `TBD`                     | `TBD`                     | `TBD`      |

OpenWind also needs a DPIA for its own high-risk controller processing, if any, and before any 3C
feature. Whether a DPIA is required for the platform as a whole: counsel.

### 6.8 Access and privilege review log

| Date  | Scope (OpenWind staff, platform operators, Zitadel roles, OpenBao, hosting console, backup destination) | Reviewer | Accounts reviewed | Removed or changed | Next review |
| ----- | ------------------------------------------------------------------------------------------------------- | -------- | ----------------- | ------------------ | ----------- |
| `TBD` | `TBD`                                                                                                   | `TBD`    | `TBD`             | `TBD`              | `TBD`       |

### 6.9 Retention schedule

Record, per data class, the period and the legal reason. Start from the platform defaults and let
counsel confirm them. **The comment (365) and evidence (2555) defaults are placeholders for the
owner and counsel to confirm**, as the [retention spec](specs/retention-classes.md) says.

| Data class                                                                                                     | Period (platform default)                                                                | Where set                            | Basis or reason |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------ | --------------- |
| Workflow noise, delivered outbox, usage rows, notifications, delivery attempts, dead letters, idempotency keys | 90 days (`RETENTION_DEFAULT_DAYS`)                                                       | `retention_days` in `tenants.config` | `TBD`           |
| Comments                                                                                                       | 365 days                                                                                 | `retention_comment_days`             | `TBD`           |
| Evidence (creation, state changes, typed events)                                                               | 2555 days, and never while the case is open                                              | `retention_evidence_days`            | `TBD`           |
| Data-subject export files                                                                                      | 7 days (`USER_EXPORT_TTL_DAYS`)                                                          | Env                                  | Minimisation    |
| Admin audit log                                                                                                | Not in the sweep list. Anonymised in place at tenant purge. Any other ageing: UNVERIFIED | n/a                                  | `TBD`           |
| `schedule_executions`                                                                                          | Not swept (append-only; needs a human ADR-017 amendment)                                 | n/a                                  | `TBD`           |
| Backups                                                                                                        | Deployer-defined                                                                         | Backup destination policy            | `TBD`           |
| Tenant data after deletion request                                                                             | 30 days default, 1 to 365                                                                | `delayDays` on tenant delete         | `TBD`           |

### 6.10 Training log

| Date  | Person or role | Topic (data protection basics, breach reporting, secure handling, SSDLC) | Provider | Evidence |
| ----- | -------------- | ------------------------------------------------------------------------ | -------- | -------- |
| `TBD` | `TBD`          | `TBD`                                                                    | `TBD`    | `TBD`    |

## 7. Legal basis

### 7.1 Customer tenant data: the customer decides, OpenWind follows instructions

For tenant data OpenWind does not choose the lawful basis. **The customer (controller) determines
the purposes and the Art. 6 basis** (and Art. 9 condition for special categories) and carries the
duty to inform its data subjects. OpenWind processes only on documented instructions (DPA 4.3.a).

Get these written confirmations from the customer before go-live:

- [ ] They are the controller and have a lawful basis (Art. 6, and Art. 9 if applicable) for each
      category of data they will load.
- [ ] Their privacy notices to employees, customers and others cover the use of OpenWind and
      its sub-processors.
- [ ] They will not load categories excluded by the order form (for example special-category data,
      children's data) unless agreed in writing and a DPIA is done.
- [ ] For employee data in the HRMS module: they have checked national employment law and any
      works-council or consultation requirement. **Consent is rarely a valid basis for employee
      data** because of the power imbalance (counsel).
- [ ] They will handle data-subject requests and use the tools in section 7.5, and tell OpenWind
      of requests that need OpenWind's help.
- [ ] Their named contacts (section 5.5) are accurate.
- [ ] They are responsible for the lawfulness of instructions given through tenant admins.
- [ ] For India: they are the Data Fiduciary and have their notice and consent or "legitimate
      uses" ground in place under the DPDP Act (counsel).

### 7.2 OpenWind's own controller activities

Suggested bases. **All are suggestions for counsel to confirm.** DPDP Act points need counsel
because the details depend on rules in force: **UNVERIFIED**.

| Purpose                                           | Data                                                  | Suggested basis, GDPR Art. 6                                                                               | DPDP Act (UNVERIFIED, counsel)                                |
| ------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Perform the customer contract, account admin      | Contact names, work emails, role                      | 6(1)(b) contract (where the customer is an individual) or 6(1)(f) legitimate interests (business contacts) | Likely "legitimate use" for performing a contract, or consent |
| Billing and accounting                            | Billing contacts, invoices                            | 6(1)(c) legal obligation for tax and accounting records; 6(1)(b)                                           | Legitimate use: compliance with law                           |
| Security and audit logging                        | User ids, IP addresses, actions, correlation ids      | 6(1)(f) legitimate interests (securing the service); LIA below                                             | Legitimate use for security, or consent; counsel              |
| Error tracking and telemetry                      | Scrubbed error events, metrics, traces                | 6(1)(f) legitimate interests; off by default                                                               | Counsel                                                       |
| Usage metering                                    | Per-tenant counts                                     | 6(1)(b) contract                                                                                           | Counsel                                                       |
| Support                                           | Contact details, ticket content, possible data access | 6(1)(b) or 6(1)(f). Access to customer data is as **processor**, not controller                            | Counsel                                                       |
| Breach handling and legal claims                  | Incident records                                      | 6(1)(c) and 6(1)(f)                                                                                        | Legitimate use: compliance with law                           |
| Marketing to business contacts, website analytics | Prospect contacts, cookies                            | 6(1)(f) for B2B marketing where permitted; **consent** for non-essential cookies (ePrivacy)                | Consent                                                       |

**Short legitimate-interests assessment (LIA) for security logging.** Purpose: detect and
investigate misuse and meet breach duties. Necessity: a breach cannot be investigated without
who, what and when; no less intrusive method gives that. Balance: logs hold identifiers and
actions, not message content (audit snapshots are redacted), and are kept within the retention
policy. Safeguards: access limited to the response group, anonymisation on tenant purge.
Counsel to confirm. Keep a signed copy per activity.

### 7.3 Special categories, HR data and children

- **Special-category data (Art. 9) and criminal data (Art. 10):** not to be loaded unless the
  order form allows it, a DPIA is done, and the customer has an Art. 9 condition. Free-text
  fields (ticket descriptions, comments, attachments) can hold such data whatever the module is
  meant for: warn the customer.
- **HRMS and employee data:** core modules, including HRMS, are installed automatically on every
  new tenant (verified in `ModuleService`: seven modules have `category: "core"`). A tenant that
  does not want HR data in scope should uninstall the module (`POST /modules/:slug/uninstall`).
  **Uninstall only removes the slug from `tenants.config.installed_modules`; it does not delete
  seeded workflows, entity types or records** (verified in `ModuleService.uninstallModule`), so
  treat it as hiding the module, not erasing data. The DPA annex should list the categories
  actually used (see 8.4).
- **Children's data:** the platform has no age gating. DPDP treats under-18s as children, with
  verifiable parental consent and limits on tracking: counsel. Do not onboard a customer whose
  data subjects are children without counsel review.

### 7.4 What the platform stores about security and reporting activity

- **Audit log:** snapshots are redacted, so it shows what happened, not the personal data itself
  ([breach runbook](runbooks/breach-notification.md)). At tenant purge the log is **anonymised in
  place**, not deleted: person identifiers in `actor_id`, `acting_person_id` and the JSON columns
  are replaced and aggregate history survives ([spec](specs/audit-log-json-anonymization.md)).
- **Reporting audit (Superset):** query and export events go to `admin_audit_log` through
  `record_reporting_audit()` ([ADR-019](decisions/ADR-019-reporting-tenant-isolation.md),
  Proposed). The Superset logger stores a typed SQL statement **truncated to 4000 characters**
  (`docker/superset/superset_config.py`). Typed SQL can itself contain personal data, and the
  stored actor is the Zitadel login name in Stage 2. **It is capped, not pseudonymised.** The ADR
  records a shipped gap where the Superset side did not fire (tracked in #709): confirm the
  current state before relying on this audit. Stage 2 is off by default.
- **Event history** in `workflow_events` is swept by class (section 6.9).

### 7.5 Data-subject rights: who does what

| Right                                                        | Who answers the person | What OpenWind provides                             | Platform feature (verified)                                                                                                                 |
| ------------------------------------------------------------ | ---------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Access, portability (Art. 15, 20)                            | Customer               | Help within the DPA time limit                     | `POST /users/:userId/export` (admin). Confirm shipped, spec status `in-progress`                                                            |
| Erasure (Art. 17)                                            | Customer               | Tools and help; confirm to the customer in writing | `DELETE /users/:userId` (admin): anonymise or delete, plus Zitadel and Superset erasure. Tenant purge for the whole tenant                  |
| Rectification (Art. 16)                                      | Customer               | Customers edit records in the app                  | Normal record editing                                                                                                                       |
| Restriction, objection                                       | Customer               | Help as needed                                     | `retention_hold` is a **tenant-wide** hold on retention sweeps, not a per-person restriction. No per-person restriction feature: UNVERIFIED |
| Requests to OpenWind as controller (contacts, logs, website) | OpenWind               | Own response within one month, extendable          | Privacy contact (5.6)                                                                                                                       |

If a data subject writes to OpenWind about tenant data, OpenWind passes it to the customer without
answering on the merits (unless the DPA says otherwise), and records it in register 6.6.

## 8. Technical onboarding checklist

For the engineers who provision. Run it in a **non-production rehearsal** first for the first
customer. Pointers are to code or docs that were read for this page.

| #    | Step                                                                                                                                                                                                                                                                                                                                                                               | Pointer and what to check                                                                                                                                                                                                                                                             | Done |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 8.0  | Preconditions: contracts and DPA signed, contacts filed, section 7.1 confirmations received, registers 6.1 to 6.4 updated                                                                                                                                                                                                                                                          | Sections 4 to 7                                                                                                                                                                                                                                                                       | [ ]  |
| 8.1  | **Provision the tenant.** `POST /admin/tenants` with `name`, unique `slug` (lowercase, digits, hyphens), `plan` and optional `config`                                                                                                                                                                                                                                              | `apps/api/src/lib/tenant-lifecycle.ts` (`provisionTenant`). Superadmin in the operator org only, with live token introspection. Created `active` (a `created` audit entry is written). Slug clash returns 409                                                                         | [ ]  |
| 8.2  | **Create the customer's Zitadel organisation and map it.** The login resolves the tenant from the token's Zitadel org through `tenants.zitadel_org_id`. Production **fails closed** (404) for an unmapped org                                                                                                                                                                      | `packages/auth/src/middleware.ts` (`resolveTenantIdForAuth`). **UNVERIFIED:** `provisionTenant` does not set `zitadel_org_id` and no route for a real customer tenant was found. The sandbox worker does set it. Confirm the real procedure and write it up before the first customer | [ ]  |
| 8.3  | **Roles and users.** Project roles are `admin`, `agent`, `user`, plus department roles `it_security`, `legal`, `finance_approver` for vendor approval. Grant the customer's first `admin`; they grant the rest                                                                                                                                                                     | `scripts/bootstrap.ts` roles list. Sandbox grants `admin`, `agent`, `user` only (`SANDBOX_GRANTED_ROLE_KEYS`). `superadmin` is the platform operator role: never grant it to a customer user                                                                                          | [ ]  |
| 8.4  | **Modules.** Seven `core` modules are installed automatically: helpdesk, crm, hrms, reimbursements, projects, invoicing, procurement. `tender` and `vendor-approval` are `optional`. Check `modules.failed` in the provisioning response, retry failures with `POST /modules/:slug/install`, hide unwanted ones with `POST /modules/:slug/uninstall` (hides only, deletes no data) | ADR-005; `apps/api/src/services/module-service.ts`; `apps/api/src/routes/modules/index.ts` (admin role). Provisioning commits the tenant first and installs modules independently, so a failed module does not block the tenant                                                       | [ ]  |
| 8.5  | **Retention.** Set `retention_days`, `retention_comment_days`, `retention_evidence_days` (and `retention_hold` only for a legal hold) at provisioning or with `PATCH /admin/tenants/:id/retention`. Shortening needs `confirmShorten: true`. Record in 6.9                                                                                                                         | [Retention classes spec](specs/retention-classes.md). Bounds 7 to 3650, 30 to 3650, 365 to 7300 days. Audited with before and after snapshots                                                                                                                                         | [ ]  |
| 8.6  | **SSO and IdP.** Decide local Zitadel users or federation to the customer's IdP. Enable MFA policy as the customer requires                                                                                                                                                                                                                                                        | **UNVERIFIED** for federation: not described in the repo. Zitadel administration is the deployer's ([deployment hardening](deployment-hardening.md))                                                                                                                                  | [ ]  |
| 8.7  | **Access controls.** Set `ip_allowlist` if the customer wants it; set `rate_limit_per_min` if the default does not fit; set `PLATFORM_ORG_ID`, `TRUST_PROXY`                                                                                                                                                                                                                       | `tenants.config` keys, `packages/auth/src/middleware.ts`, [ADR-013](decisions/ADR-013-unified-rate-limiting-strategy.md), deployment hardening "Client addresses, rate limits and request size"                                                                                       | [ ]  |
| 8.8  | **Plan and usage.** Confirm `plan`; usage and degrade behaviour (API calls, storage, AI tokens) apply per plan                                                                                                                                                                                                                                                                     | ADR-015 Decisions 3 and 5. Plan limit values: `TBD`, not verified here                                                                                                                                                                                                                | [ ]  |
| 8.9  | **Backups and restore test.** Encrypted, off-host, access-controlled, key stored separately; one restore (including OpenBao) tested and timed                                                                                                                                                                                                                                      | [Backup and DR](specs/backup-dr-runbook.md); deployment hardening "Backup encryption" and go-live checklist. 24 hour RPO. T7 (OpenBao restore) status: re-check                                                                                                                       | [ ]  |
| 8.10 | **Secrets.** Production OpenBao per ADR-023; `NODE_ENV=production` in API and worker; no dev tokens                                                                                                                                                                                                                                                                                | [OpenBao runbook](runbooks/openbao-secrets.md); `printenv NODE_ENV` check in deployment hardening                                                                                                                                                                                     | [ ]  |
| 8.11 | **Encryption and network.** TLS and HSTS at the proxy, disk encryption for Postgres, files, Zitadel DB, OpenBao, backups                                                                                                                                                                                                                                                           | Deployment hardening go-live checklist                                                                                                                                                                                                                                                | [ ]  |
| 8.12 | **Observability.** Decide `observability` profile on or off, `ERROR_TRACKING_PROVIDER`, `OPS_ALERT_EMAIL`, key-expiry alerts, retention-sweep metric `openwind_retention_deleted_rows_total`                                                                                                                                                                                       | ADR-015; `docker/observability/alert.rules.yml`; deployment hardening "Zitadel machine-key rotation". If error tracking is on, record the provider as a sub-processor                                                                                                                 | [ ]  |
| 8.13 | **Notifications.** Configure the outbound delivery service, per-channel providers and the kill switch contact. Record providers as sub-processors                                                                                                                                                                                                                                  | [Outbound contract](notification-outbound-contract.md), [kill switch spec](specs/outbound-notifications-kill-switch.md)                                                                                                                                                               | [ ]  |
| 8.14 | **Reporting.** Leave Superset Stage 2 off unless approved. If on, check the erasure setup (`SUPERSET_OAUTH_CLIENT_ID` and service account password at the worker's OpenBao path)                                                                                                                                                                                                   | [Superset erasure runbook](runbooks/superset-erasure.md) "Production setup"; ADR-019 (Proposed)                                                                                                                                                                                       | [ ]  |
| 8.15 | **Data residency.** Record where the stack runs and where backups go. There is no per-tenant region                                                                                                                                                                                                                                                                                | ADR-015 Deferred Decisions. Hosting region: `TBD`                                                                                                                                                                                                                                     | [ ]  |
| 8.16 | **AI.** Confirm no AI feature is enabled. `ANTHROPIC_API_KEY` is optional and should stay unset unless the customer opted in                                                                                                                                                                                                                                                       | `packages/config/src/env.ts`; no application imports `@platform/ai`                                                                                                                                                                                                                   | [ ]  |
| 8.17 | **File storage.** `FILES_STORAGE_PATH_HOST` is owned by uid 1000 and encrypted; ClamAV is running                                                                                                                                                                                                                                                                                  | Deployment hardening "File storage ownership"                                                                                                                                                                                                                                         | [ ]  |
| 8.18 | **Isolation smoke test.** With two tenants, confirm a customer admin cannot see the other tenant's records                                                                                                                                                                                                                                                                         | `pnpm test:isolation` is the automated guard (ADR-001)                                                                                                                                                                                                                                | [ ]  |
| 8.19 | **Handover.** Send credentials by a secure route, record who is the tenant admin, schedule the access review                                                                                                                                                                                                                                                                       | Registers 6.8 and 6.3                                                                                                                                                                                                                                                                 | [ ]  |

## 9. Acceptance gates before go-live

Every gate needs a named approver and evidence. Any "No-go" stops go-live.

| #   | Gate                                                                                                          | Evidence                                               | Approver          | Go / No-go |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------- | ---------- |
| G1  | Contracts signed in the order of 4.14, **DPA before real data**                                               | Register 6.3 entry                                     | Owner             | `TBD`      |
| G2  | Counsel has reviewed the DPA templates and this page (once, before the first paying customer)                 | Dated sign-off, filled in the header table             | Counsel           | `TBD`      |
| G3  | Sub-processor list is accurate and sent to the customer; transfer mechanism in place                          | Registers 6.2 and 6.4                                  | Owner             | `TBD`      |
| G4  | Customer written confirmations and contacts received                                                          | Section 7.1 list, section 5.5 sheet                    | Account owner     | `TBD`      |
| G5  | Special-category screen and DPIA screen done; DPIA complete if triggered                                      | Register 6.7                                           | Privacy contact   | `TBD`      |
| G6  | Representatives decided (EU, UK) and named where required                                                     | Section 5 decision record                              | Owner and counsel | `TBD`      |
| G7  | Breach readiness: owner named, intake channel live, runbook open facts filled, tabletop run in last 12 months | Breach runbook open-facts table                        | Breach owner      | `TBD`      |
| G8  | Technical checklist section 8 complete in the target environment                                              | Ticked checklist with evidence                         | Security lead     | `TBD`      |
| G9  | Restore tested within the last quarter, with key recovery                                                     | Test record                                            | Security lead     | `TBD`      |
| G10 | Deployment hardening go-live checklist complete                                                               | [Checklist](deployment-hardening.md#go-live-checklist) | Security lead     | `TBD`      |
| G11 | Registers 6.1 and 6.6 updated for this customer; retention schedule recorded                                  | Register entries                                       | Privacy contact   | `TBD`      |
| G12 | Exit plan agreed (section 10) and the support route tested                                                    | Order form clause, support intake test                 | Owner             | `TBD`      |

**Go** only when every gate is "Go". A signed exception from the owner, with the reason and a
date for closing it, is the only alternative: record it in the contract register.

## 10. Offboarding and exit

| Step                          | What happens                                                                                                                                                                                                                                                                                              | Pointer                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 10.1 Exit notice and choice   | Customer chooses return then delete, or delete. Agree the dates in writing                                                                                                                                                                                                                                | DPA clause 4.3.g                                                                                                |
| 10.2 Return and export        | Export the customer's data before deletion: entity exports through the export queue (audited), per-user data export for individuals. A single "export everything for a tenant" feature: UNVERIFIED (not found); the per-tenant logical dump is an enterprise-tier item deferred in ADR-015                | [Export audit trail](specs/export-audit-trail.md), [user data export](specs/user-data-export.md)                |
| 10.3 Suspend                  | Optionally suspend the tenant (`PATCH /admin/tenants/:id/suspend`) to stop access while preserving data                                                                                                                                                                                                   | `tenant-lifecycle.ts`                                                                                           |
| 10.4 Schedule deletion        | `DELETE /admin/tenants/:id` with `delayDays` (default 30, minimum 1, maximum 365). Status becomes `deleted`. Use a legal hold (`retention_hold`) or hold the purge if a dispute or incident is open                                                                                                       | `apps/api/src/routes/admin/tenants.ts`, [breach runbook](runbooks/breach-notification.md) (purge and hold)      |
| 10.5 Purge                    | The `tenant-purge` worker hard-deletes the tenant's data in foreign-key order, removes on-disk files (best effort, outside the DB transaction), clears the sandbox handover key, and sets `purged`. Coverage is enforced by a guard test that fails when a new tenant table is not purged or exempted     | `apps/worker/src/tenant-purge.ts`, [erasure coverage spec](specs/gdpr-erasure-coverage.md)                      |
| 10.6 Identity provider        | The purge worker does **not** call Zitadel (no reference found in `tenant-purge.ts`). The customer's Zitadel org and users must be removed separately for a real tenant, by the operator. The sandbox delete worker does remove its org. Write the real procedure: **UNVERIFIED**                         | `apps/worker/src/tenant-purge.ts`, `apps/worker/src/sandbox-delete-worker.ts`                                   |
| 10.7 Superset                 | With Stage 2 on, the purge queues a `superset-erasure` job for every Superset user of the tenant and flushes the result cache. Check the `superset_erasure.completed` audit row. With Stage 2 off, only the cache is flushed                                                                              | [Superset erasure runbook](runbooks/superset-erasure.md)                                                        |
| 10.8 What is kept, and why    | The admin audit log is anonymised in place, not deleted (aggregate history survives). Counsel to confirm the legal basis. Nothing else tenant-scoped should remain except documented exemptions                                                                                                           | [Audit anonymisation spec](specs/audit-log-json-anonymization.md), `ERASURE_EXEMPT_TABLES` in `tenant-purge.ts` |
| 10.9 Backups                  | Backups taken before the purge still contain the data until they expire. The platform has **no per-tenant selective restore or backup deletion**. State the backup retention in the DPA (`TBD`), and make sure a restore of an old backup never reintroduces a purged tenant without re-running the purge | [Backup and DR](specs/backup-dr-runbook.md), deployment hardening                                               |
| 10.10 Certificate of deletion | Send written confirmation: date of purge, what was deleted, what is kept and why, backup expiry date. No template and no generator exists: `TBD`. Evidence to cite: `purge.completed` audit row, Superset audit row                                                                                       | Register 6.6                                                                                                    |
| 10.11 Close out registers     | Mark the contract ended in 6.3, update 6.1, 6.2 (if a sub-processor is no longer needed), 6.6, and archive the customer folder under the retention rule                                                                                                                                                   | Section 6                                                                                                       |

## 11. Open questions for the owner and counsel

**For the owner**

1. Who holds each role in 5.6, and who is the legal reviewer? Several runbooks already wait on this
   ([#639](../issues/639)).
2. Which legal entity contracts with customers, and in which country? This drives Art. 27, the
   supervisory authority and governing law.
3. Where is production hosted (provider, region), and where do backups go? Needed for the transfer
   register and the data-residency answer. Is regional hosting a promise to any customer?
4. Hosted, self-hosted, or both for the first customers? It decides whether a DPA is needed.
5. Is Zitadel run by OpenWind or a managed service, and how is a real customer tenant mapped to its
   Zitadel org (8.2 is unverified)? Who removes the org at exit (10.6)?
6. What is the support-access rule (who, when, how recorded)? It decides whether OpenWind is a
   processor in self-hosted deployments.
7. What delivery providers sit behind the outbound notification service (4.5, 8.13)?
8. What contractual breach-notice hours, SLA figures and fees? None are set here.
9. Licence position: how do the AGPL licence and the hosted terms fit together?
10. Which comment and evidence retention defaults (365 and 2555 days) will be promised?
11. Is "export everything for a tenant" needed before the first customer (10.2)?
12. Is the per-user data export (#642) shipped in your deployment? Its spec says `in-progress`.

**For counsel**

1. Is OpenWind a processor, a controller or both for each activity in section 2? Confirm the bases
   in 7.2 and the LIA.
2. Art. 27 EU and UK representatives: needed or not, given the entity and sales model.
3. DPO: is one required for OpenWind, and may the owner act as privacy contact?
4. DPDP Act 2023: restricted-country transfer rules in force, any resident-representative rule, the
   Significant Data Fiduciary position, children's data, the grievance contact, and how the
   rules apply to a processor.
5. DPA wording for each clause in 4.3, the audit-rights model, sub-processor notice period, and
   liability and indemnity (4.9).
6. Transfer mechanism and transfer impact assessment for each sub-processor and for support access.
7. Whether keeping the audit log after a tenant purge (anonymised) satisfies Art. 17(3)(b) or the
   customer's own retention duties.
8. Whether the 4000-character typed-SQL record in reporting audit is acceptable data minimisation.
9. Whether a standard DPIA is needed for the platform or the HRMS module.
10. The AI addendum position before any 3C feature uses real data (ADR-018 OQ-6).
11. Whether backup copies that outlive a purge are acceptable, and the maximum backup retention to
    promise.

## Maintenance

- Change this page in the same pull request as any change to tenant lifecycle, retention, erasure,
  roles, module install, sub-processors or the breach runbook.
- When a `TBD` is filled with a customer-specific value, move it out of this repository.
- When counsel signs off, fill in the header table and change the banner.
