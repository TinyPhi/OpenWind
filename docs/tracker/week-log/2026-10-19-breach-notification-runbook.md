# 2026-10-19 — GDPR Article 33 breach-notification runbook (#639)

**Session type:** Docs
**Branch:** `docs/PLAT-639-breach-notification-runbook`
**Issues:** #639

- **Done.**
  - New `docs/runbooks/breach-notification.md`: triage, the personal-data-breach test, the 72-hour
    clock, containment and evidence preservation, a notify-authority or notify-people decision
    tree, Art. 33(3) content checklist, processor-to-controller flow (hosted), self-hosted notes,
    breach register fields (Art. 33(5)), roles, three short templates, post-incident review and a
    tabletop checklist. It covers both deployment models.
  - States what the platform can and cannot detect today (third-party API misuse alerts only;
    #641 and part of #640 are not done), so it does not overstate coverage.
  - Linked from `docs/deployment-hardening.md`.
- **Not done.** The security intake contact, on-call owner, legal reviewer and supervisory
  authorities are `TBD` placeholders in a marked block. The runbook carries a "not yet legally
  reviewed" banner and has had no legal review.
- **For a human.** ADR-015 should link to the runbook (#639 acceptance criterion 3). ADR files are
  human-only, so this change does not edit it. #639 stays open until legal review.
