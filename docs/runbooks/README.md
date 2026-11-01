# Runbooks

Step-by-step procedures for operating OpenWind. A runbook says how to do something; the decision
behind it lives in an ADR under [docs/decisions/](../decisions/) and is linked from the runbook.

| Runbook                                                        | Use it when                                                                                                          | Status                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [OpenBao secrets](openbao-secrets.md)                          | Setting up production secrets, moving a running instance over, rolling back, rotating, rebooting                     | In use (ADR-023)                                              |
| [Breach notification](breach-notification.md)                  | A personal-data breach is suspected or confirmed (GDPR Article 33, 72-hour clock)                                    | Draft, not yet legally reviewed; open facts to fill in (#639) |
| [Superset erasure](superset-erasure.md)                        | An erased user's or purged tenant's data may still be in Superset, or the `SupersetErasureFailed` alert fired (#728) | In use                                                        |
| [Vendor approval walk-through](vendor-approval-walkthrough.md) | Running the live Zitadel -> admin-ui -> SLA worker check for the vendor-approval module (#691, T12)                  | Ready to run; unverified steps marked                         |

Other operational docs that are not runbooks: [deployment hardening](../deployment-hardening.md)
(go-live controls), [local setup](../local-setup.md), and the
[backup and DR runbook](../specs/backup-dr-runbook.md) (kept with the specs).

## Adding a runbook

- One page per procedure, named for the situation (`breach-notification.md`), not the tool.
- Open with who owns it and when to use it. Link the ADR that explains the design.
- Mark anything unknown as an explicit placeholder; never invent contacts or values.
- Add a row to the table above in the same change.
