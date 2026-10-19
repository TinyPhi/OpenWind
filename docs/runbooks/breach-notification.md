# Personal-data breach response runbook (GDPR Article 33)

> **NOT YET LEGALLY REVIEWED.** This runbook is an engineering draft. No legal or compliance owner
> has approved it. Do not rely on it for a real incident until the reviewer named in
> [Open facts](#open-facts-to-fill-in-before-use) has signed it off. When a real incident is in
> progress, involve counsel immediately; this page does not replace that. Nothing here is legal
> advice.

How OpenWind handles a suspected or confirmed personal-data breach: who is told, what the 72-hour
clock means, what to contain and preserve, and what to send. It covers the two ways OpenWind is
run, because the legal role differs:

- **Hosted**: OpenWind operates the platform for a customer. OpenWind is the **processor**; the
  customer is the **controller**.
- **Self-hosted**: the operator runs the platform on their own infrastructure. The operator is the
  **controller** (and runs the infrastructure). OpenWind, as the software vendor, is a processor
  only for what it does itself, such as support access.

Related: [ADR-015](../decisions/ADR-015-observability-compliance.md) (observability, audit,
retention and erasure), [deployment hardening](../deployment-hardening.md) (who owns which
control), [backup and DR](../specs/backup-dr-runbook.md) (availability, a different concern),
[OpenBao secrets runbook](openbao-secrets.md) (credential rotation).

## Open facts to fill in before use

These are unknown today. They are deliberately left as placeholders. Do not guess them and do not
copy values from elsewhere. Fill them in through a reviewed change.

| Item                                        | Value                         |
| ------------------------------------------- | ----------------------------- |
| Security intake contact and channel         | `TBD: not decided`            |
| Incident commander (on-call owner) rota     | `TBD: not decided`            |
| Legal / compliance reviewer of this runbook | `TBD: not decided`            |
| Legal / compliance contact during incidents | `TBD: not decided`            |
| Supervisory authority, hosted deployments   | `TBD: depends on the entity`  |
| Supervisory authority, self-hosted (each)   | `TBD: set by each operator`   |
| Customer notification contacts (hosted)     | `TBD: from each customer DPA` |
| Breach register location                    | `TBD: not decided`            |
| Date of last legal review                   | `TBD: never reviewed`         |

For self-hosted, the operator fills in their own supervisory authority and contacts. OpenWind does
not know them.

## What this platform can and cannot detect today

The 72-hour clock starts when you become aware, so detection matters. Be honest about the gaps and
do not assume a breach would have been caught.

**What exists**

- **Append-only audit log** (`admin_audit_log`, `@platform/audit`: `writeAuditEntry`,
  `queryAuditLog`). It records entity mutations, tenant lifecycle changes and export activity
  (`export.requested`, `export.completed`, `export.failed`, which record who exported what, row
  count, format and whether PII fields were included; see
  [export audit trail](../specs/export-audit-trail.md)). Snapshots are redacted, so it shows what
  happened, not the personal data itself.
- **Event history** in `workflow_events`, protected from rewrite by the request role
  ([event-log protection](../specs/event-log-protection.md)).
- **Third-party API misuse alerts** (`apps/api/src/lib/misuse-alerts.ts`): a recognised API key
  with a burst of scope denials (10 in 5 minutes), a volume spike against its trailing baseline,
  and the tagging-grant cap. They go to the admin alert channel via `fireMisuseAlert`. They cover
  **only the third-party API surface**.
- **Prometheus alert rules** (`docker/observability/alert.rules.yml`, profile `observability`):
  queue depth, 5xx rate, latency, on-call, notification and schedule health, OpenBao down or
  sealed. These are reliability signals. They can hint at an incident (a 5xx or queue spike) but
  they are not security detection.
- **API key records** keep `revoked_at` (ADR-008), so a revoked key stays available to an
  investigation.
- **Sentry-protocol error tracking** is off by default (`ERROR_TRACKING_PROVIDER=none`). When on,
  events pass through PII scrubbing in `packages/telemetry/src/errors.ts` (`beforeSend`), and an
  event is dropped if scrubbing itself fails.

**What does not exist yet**

- No alerting on repeated login failures, RLS-denial bursts or unusual export volume on the
  admin/agent surface. This is tracked in [#641](../../issues/641) and is not built.
- No automated detection of exfiltration, bulk reads or unusual access outside the third-party
  API.
- Role and permission change auditing is tracked in [#640](../../issues/640). Check its
  status before relying on the audit log to answer "who changed access".
- Cross-tenant access denied by RLS is not logged (the row is simply invisible), so a
  cross-tenant probing attempt leaves no audit entry.
- Host, network, reverse proxy, disk and backup-destination security belong to the deployer
  (see [deployment hardening](../deployment-hardening.md)). OpenWind cannot see them.

In practice most incidents will first arrive as a **report** (a customer, a researcher, an
employee, a provider), not an alert. Treat the intake channel as the main detector.

## Roles

| Role                             | Responsibility                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Reporter                         | Anyone who notices something. Reports it to the intake channel and does nothing else to the evidence. |
| Incident commander (IC)          | Owns the response, the timeline and the clock. `TBD: on-call owner`.                                  |
| Technical lead                   | Contains, investigates, preserves evidence. Reports facts to the IC.                                  |
| Legal / compliance               | Decides whether it is a notifiable breach, approves every external notice. `TBD: reviewer`.           |
| Communications owner             | Sends the approved notices and keeps the log of what was sent. Often the IC.                          |
| Customer success / account owner | Hosted only: the relationship contact for the affected customer.                                      |
| Operator security contact        | Self-hosted only: the operator's own equivalent of all of the above.                                  |

One person can hold several roles in a small team. The IC and the person approving external notices
should be different people where possible.

## Step 1: Intake and triage (first hour)

1. **Receive.** A report arrives at the intake channel (`TBD: security intake contact`). Whoever
   gets it forwards it to the IC straight away. Do not wait to be sure it is real.
2. **Open a record.** The IC opens a breach register entry
   ([fields](#breach-register-art-335)) and writes the time the report was received, who reported
   it, and the exact words used.
3. **Start the timeline.** Record every action with a UTC timestamp from this point.
4. **Classify** with the table below.
5. **Apply the personal-data breach test.**

### Is it a personal-data breach?

Article 4(12): a breach of security leading to the **accidental or unlawful destruction, loss,
alteration, unauthorised disclosure of, or access to, personal data** that was transmitted, stored
or otherwise processed. Ask in order:

1. Did a security incident actually happen (not just a vulnerability that was not exploited)?
2. Could the incident have touched personal data (names, emails, ticket content, comments,
   attachments, directory data, audit log identifiers, reporting data, backups, logs)?
3. Was the data **destroyed, lost, altered, disclosed or accessed** without authorisation? Loss of
   availability alone (an outage with intact data) is generally not a breach, but a permanent loss
   of data is. A temporary outage that also exposed data is.
4. Is the evidence **unknown**? Treat unknown as "possibly yes" until the investigation can rule
   it out. Say so in the register.

If the answer to 1 to 3 is yes, it is a personal-data breach and the clock questions below apply.
If the answer is no, record why in the register and close it. A vulnerability with no sign of
exploitation is handled as a security fix, not a breach, but record the reasoning.

### Severity

| Level | Meaning                                                                                                     | Response                                                |
| ----- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| SEV1  | Confirmed or likely unauthorised access to or disclosure of personal data, multiple tenants or special data | IC and legal immediately. Clock treated as running.     |
| SEV2  | Confirmed or likely exposure for one tenant, or exposure of credentials that grant access to personal data  | IC and legal within the hour. Clock treated as running. |
| SEV3  | Incident with no evidence of personal-data exposure, or exposure of already-public or non-personal data     | IC decides. Register entry with reasoning.              |
| SEV4  | Vulnerability report with no exploitation, or false alarm                                                   | Normal security process. Register entry.                |

When two levels fit, choose the higher one until evidence says otherwise.

### Examples against this platform

- A third-party API key used outside its expected pattern: a misuse alert fired, or a customer
  reports it. Check the key's access log and audit entries (SEV2 if real data was read).
- A leaked `sk_` key, role file, OpenBao secret ID or Zitadel machine key: credential exposure
  (SEV2 until access is ruled out).
- A bug that lets one tenant read another tenant's rows (RLS or tenant-check failure): SEV1.
- A bulk export by a user who should not have it: check `export.requested` entries.
- A lost or stolen backup, or a backup destination opened to the public: the backup script does
  not encrypt, so treat an unencrypted copy as a full disclosure (SEV1).
- Personal data sent to the wrong recipient by a notification or integration: SEV2 or SEV3 by
  scope.

## Step 2: The 72-hour clock

Article 33(1): notify the supervisory authority **without undue delay and, where feasible, not
later than 72 hours after having become aware** of the breach, unless the breach is unlikely to
result in a risk to the rights and freedoms of people. If notification is late, the notice must
give the reasons for the delay.

**When does awareness start?** The point at which the controller has a reasonable degree of
certainty that a security incident has occurred that led to personal data being compromised. A
report that is plausible but unverified starts a short investigation period, not a free pause. Do
not use "still investigating" to defer the clock for days. Record the moment you judged awareness
to have started, and why, in the register. Legal decides this.

| Deployment  | Whose clock                                                                                                                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosted      | OpenWind as processor must notify the **customer (controller)** without undue delay after becoming aware (Art. 33(2)). The customer's own 72 hours to the authority start when **they** become aware, which is normally when OpenWind tells them. Tell them fast. Check the customer DPA for a shorter contractual notice period. |
| Self-hosted | The **operator** is the controller. The 72 hours to the supervisory authority run from the operator becoming aware. If the cause is in OpenWind software or OpenWind support access, OpenWind must tell the operator without undue delay.                                                                                         |

The IC writes the deadline (awareness time plus 72 hours, in UTC) at the top of the register entry
and checks it at each handover. A notice can be given in phases (Art. 33(4)): send what is known,
then follow up.

## Step 3: Contain and preserve evidence

Do these in this order of priority. Contain first when data is still leaving; preserve as you go.
Every action goes on the timeline.

**Preserve first (cheap, quick)**

1. Export the relevant slice of the audit log with `queryAuditLog` (filters: actor, resource type,
   resource id, date range) and save it somewhere write-protected. Do not edit entries. Remember
   the audit log shows redacted snapshots.
2. Save application, reverse-proxy and database logs and the correlation IDs of the requests
   involved, before log rotation removes them.
3. Take a copy of the affected database state or a snapshot if the host supports it. Note that
   `scripts/backup.sh` output is not encrypted, so handle the copy under
   [deployment hardening](../deployment-hardening.md) rules.
4. Record the commit or image version running, and the configuration (without secret values).
5. **Pause deletion that could destroy evidence.** The retention sweeps delete old event, outbox
   and usage rows. Setting `tenants.config.retention_hold: true` for the affected tenant skips
   every sweep for it (see [retention classes](../specs/retention-classes.md)); it applies from
   the next sweep run. Do not stop a data subject's erasure request without legal advice: an
   erasure obligation does not stop because an incident is open. Ask legal. A scheduled tenant
   purge (`tenants.deletionScheduledAt`, worker `tenant-purge`) hard-deletes tenant data, with the
   audit log retained. Ask the IC before letting a purge for an affected tenant run.

**Contain**

| Situation                         | Mechanism                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A third-party API key is exposed  | Revoke the key (soft revoke sets `revoked_at`, ADR-008) and rotate. The record is kept for the investigation.                                                |
| A user account is compromised     | Disable or reset the user in Zitadel (identity provider administration is the deployer's, see hardening guide). Review that user's audit entries.            |
| A tenant must be cut off          | Suspend the tenant through the tenant lifecycle (`active` to `suspended`, written to the audit log).                                                         |
| A connector or integration leaks  | Disable the connector (connector disable route) and rotate the credential it used.                                                                           |
| Outbound messages are misdirected | Use the outbound-notifications kill switch ([spec](../specs/outbound-notifications-kill-switch.md)).                                                         |
| Secrets or machine keys exposed   | Rotate through the [OpenBao secrets runbook](openbao-secrets.md) and the Zitadel machine-key rotation in [deployment hardening](../deployment-hardening.md). |
| Source IPs known and hostile      | Set `ip_allowlist` in `tenants.config` for the tenant, and block at the proxy or firewall (deployer-owned).                                                  |
| A software defect is the cause    | Ship a fix or a feature-off change through the normal delivery flow, with an emergency review. Record the PR.                                                |

Do not wipe, reboot or reimage an affected host before the technical lead confirms the evidence
copy is complete, unless data is still being taken and that is the only way to stop it. Record the
reason if you must.

## Step 4: Investigate and scope

The technical lead answers, with evidence (or "unknown" where it is unknown):

1. What happened, when it started, when it was found, whether it is still happening.
2. Which tenants, which users, which data categories, roughly how many people and records.
3. Was the data readable by the attacker (plain, redacted, encrypted)? Were keys also exposed?
4. How did it happen (the cause and the entry path)?
5. What has been contained and what has not.

Sources: audit log, export audit entries, API key access records, proxy and application logs,
database logs, Sentry events if enabled, Zitadel logs, host and backup-destination access logs.
Say clearly what you could not check because the telemetry does not exist (see the gaps above).

## Step 5: Decide whom to notify

```
Personal-data breach confirmed or cannot be ruled out
|
+-- Hosted? ----------- yes --> Processor path:
|                               Notify the customer (controller) without undue delay.
|                               The customer decides on authority and data-subject notices.
|                               OpenWind supports with facts and evidence.
|
+-- Self-hosted / OpenWind is the controller:
    |
    +-- Is the breach unlikely to result in a risk to people's rights and freedoms?
    |     (e.g. data was strongly encrypted and the key was not exposed; data already public)
    |     yes --> No authority notice needed. Record the reasoning in the register. STOP.
    |     no or unsure --> Notify the supervisory authority within 72 hours (Art. 33).
    |
    +-- Is the breach likely to result in a HIGH risk to people's rights and freedoms?
          (e.g. credentials, financial or identity data, special-category data, large scale,
          vulnerable people, easy identification of people)
          yes --> Also tell the affected people without undue delay (Art. 34), unless an
                  Art. 34(3) exception applies (strong encryption, risk neutralised by
                  follow-up measures, or disproportionate effort, which then needs a public
                  communication).
          no  --> Authority notice only. Record why the risk is not high.
```

Legal decides each branch. The technical lead provides the facts, and the IC records the decision
and the person who made it. When unsure whether to notify, the default is to notify and refine
later (Art. 33(4)).

## Step 6: Notification content (Art. 33(3))

A notice to the authority, and a processor's notice to a controller, should contain:

- [ ] The **nature of the breach**, including where possible the categories and approximate number
      of people affected and the categories and approximate number of records.
- [ ] The **name and contact details** of the data protection officer or other contact point.
- [ ] The **likely consequences** of the breach.
- [ ] The **measures taken or proposed** to address it, including measures to reduce possible
      harm.
- [ ] If late: the **reasons for the delay**.
- [ ] If phased: what is still unknown and when the next update will come.

A notice to affected people (Art. 34(2)) is in plain language and contains at least the contact
point, the likely consequences, and the measures taken or proposed, plus what people can do to
protect themselves.

Never put the personal data itself in a notice. Never name a person who reported or was involved
unless legal agrees.

## Processor-to-controller flow (hosted)

1. IC confirms awareness time and records it. Legal is told.
2. Within hours, not days, the account owner sends the initial notice to the customer's contacts
   (`TBD: from the customer DPA`), by the channel the DPA names, using the
   [processor notice template](#template-1-processor-to-controller-notice). Send what is known, say
   what is not.
3. Give the customer what they need for their own Art. 33(3) notice: nature, categories and
   counts, consequences, measures. Offer a named technical contact.
4. Keep them updated at an agreed interval until closed. Log each update in the register.
5. OpenWind does not notify the customer's supervisory authority or the customer's data subjects
   on the customer's behalf unless the customer asks in writing and legal agrees.
6. If OpenWind's own infrastructure holds data about the customer's staff (for example account
   data), OpenWind is a controller for that data and handles it as a separate breach under the
   self-hosted branch.

## Self-hosted notes

- The operator owns detection, the clock, and the notice. OpenWind cannot see their environment.
- If OpenWind learns of a defect that exposes self-hosted installs (a vulnerability in shipped
  software), OpenWind tells operators through the security intake and release channels
  (`TBD: security advisory channel`), with fixed versions and what to check in logs.
- If an operator reports a suspected defect in OpenWind, intake treats it as in
  [Step 1](#step-1-intake-and-triage-first-hour). OpenWind helps with facts; the operator decides
  and sends the notices.
- Operators should keep this runbook's tables (contacts, authority) filled in for their own
  organisation, and run the tabletop exercise below.

## Breach register (Art. 33(5))

Every breach is recorded, including ones that are not notified. Keep it in a controlled location
(`TBD: register location`), restricted to the response group. Do not put personal data in it.

| Field                      | Notes                                                                  |
| -------------------------- | ---------------------------------------------------------------------- |
| Register ID                | Unique, sequential                                                     |
| Deployment model           | Hosted or self-hosted; OpenWind role (processor, controller)           |
| Reported by / detected how | Person role or system; the first report in the reporter's own words    |
| Time reported, time aware  | UTC, with the reason awareness was judged to start then                |
| 72-hour deadline           | UTC                                                                    |
| Facts of the breach        | What, how, when, still ongoing                                         |
| Tenants and systems        | Which tenants, services, datastores                                    |
| Data categories and counts | Categories of personal data and people, approximate numbers            |
| Effects and likely harm    | Consequences for the people                                            |
| Risk assessment            | Not likely / risk / high risk, with reasoning and the decider          |
| Containment actions        | Each with time, actor and mechanism                                    |
| Evidence preserved         | What, where, who holds it, hash if taken                               |
| Notifications              | Who was told (customer, authority, people), when, by whom, with a copy |
| Decision not to notify     | The reasoning and the legal approver, if applicable                    |
| Remedial actions           | Fixes, PR links, follow-up issues                                      |
| Late-notice reason         | If applicable                                                          |
| Closed on / review done    | Date, link to the post-incident review                                 |

## Communication templates

Short forms. Replace every `<...>` and have legal approve before sending. Keep to facts; do not
speculate or assign blame.

### Template 1: Processor to controller notice

```
Subject: Personal-data breach notice (initial), reference <register ID>

We became aware at <UTC time> of a security incident affecting the OpenWind service we
provide to <customer>. We are notifying you under Article 33(2) and our agreement.

What we know: <nature of the incident, categories and approximate number of people and
records, whether it is ongoing>.
What we do not yet know: <open questions>.
Likely consequences: <short statement or "under assessment">.
What we have done: <containment and remediation steps>.
What we recommend you do: <for example reset credentials, review access>.
Contact: <TBD: named technical contact and channel>.
Next update: by <time>, or sooner if the facts change.
```

### Template 2: Notice to the supervisory authority (controller)

```
To: <TBD: supervisory authority>    Re: Personal-data breach notification (Art. 33)

Controller: <name, contact point / DPO>
Became aware: <UTC>    Notified: <UTC>    Late? <no / yes, reason>
Nature of the breach: <description, categories and approximate number of people and records>
Likely consequences: <...>
Measures taken or proposed: <...>
Cross-border: <countries involved, or none known>
Further information will follow: <what and when>
```

Use the authority's own form or portal where one exists. Check whether cross-border processing
means a lead authority applies (`TBD: legal`).

### Template 3: Notice to affected people (Art. 34)

```
Subject: A security incident affecting your information

On <date> we found that <plain description of what happened>. The information involved
may include <categories, such as name and email address>. It did not include <if known>.

What this may mean for you: <likely consequences>.
What we have done: <measures>.
What you can do: <practical steps>.
Questions: <TBD: contact point>.
```

## Closing the incident and post-incident review

1. The IC confirms containment is complete and every notice and follow-up has gone out.
2. Release temporary holds (`retention_hold`, suspended tenants, IP restrictions) only on the IC's
   word, and record when. A forgotten `retention_hold` silently stops retention sweeps for that
   tenant.
3. Hold a blameless review within a set time after closure (`TBD: agree interval`). Cover:
   timeline, detection (how was it found, how long it took, which gap in the list above
   mattered), response delays, what the audit log and telemetry could and could not answer, and
   the 72-hour clock performance.
4. File issues for each follow-up. Candidates: missing detection ([#641](../../issues/641)),
   missing audit actions ([#640](../../issues/640)), customer communication gaps.
5. Update this runbook, the register entry, and (via a human) the ADR if the architecture changes.
6. Tell customers or operators the outcome and the permanent fix.

## Tabletop exercise checklist

Run at least yearly and after a major change. Record who attended and what broke.

- [ ] Pick a scenario: leaked third-party API key; cross-tenant read bug; unencrypted backup
      found in a public bucket; compromised admin account; misdirected notification.
- [ ] Start the clock at the moment the scenario is read out. Who is told first and how fast?
- [ ] Can the team reach the intake contact, the IC, and legal at 2am on a weekend?
- [ ] Walk the personal-data breach test and set the awareness time. Does everyone agree?
- [ ] Practise `queryAuditLog` for the scenario. Can the team answer who, what and how many?
- [ ] Practise one containment step in a non-production stack: revoke a key, suspend a tenant,
      set `retention_hold`.
- [ ] Draft the processor notice and the authority notice from the templates. Time it.
- [ ] Walk the decision tree for both deployment models. Do the contacts table entries exist?
- [ ] Fill in a register entry completely.
- [ ] List what the team could not see (detection gaps) and file an issue for each.
- [ ] Update this page with what was learned and get the change reviewed.
