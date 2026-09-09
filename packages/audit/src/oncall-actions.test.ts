/**
 * audit log oncall action strings -- docs/specs/oncall-routing.md T4/T44.
 *
 * Confirms the three new oncall.* AuditAction values are wired into every
 * exhaustiveness map in the same commit as the DB CHECK constraint
 * (migration 0095_admin_audit_log_oncall_actions.sql), per the Phase C B1
 * incident's self-imposed rule documented in outcome.ts/request-kind.ts.
 */

import { describe, it, expect } from "vitest";
import { classifyOutcome, ALL_AUDIT_ACTIONS } from "./outcome.js";
import { classifyRequestKind } from "./request-kind.js";

const ONCALL_ACTIONS = [
  "oncall.auto_assigned",
  "oncall.no_schedule",
  "oncall.skipped_explicit_assignee",
] as const;

describe("audit log oncall action strings", () => {
  it.each(ONCALL_ACTIONS)("%s is a recognized AuditAction value", (action) => {
    expect(ALL_AUDIT_ACTIONS).toContain(action);
  });

  it.each(ONCALL_ACTIONS)(
    "%s classifies as allowed -- none represent a denied caller request",
    (action) => {
      expect(classifyOutcome(action)).toBe("allowed");
    },
  );

  // PR #583 review, S3: oncall.no_schedule and oncall.skipped_explicit_assignee
  // classify "write" even though NEITHER mutates the ticket's assignee (R9's
  // fail-open path, R10's explicit-assignee-wins path) -- unlike
  // oncall.auto_assigned, which does. The classification is "write" for all
  // three because they're written at the same decision point in the
  // automation flow (a team_id-change event resolving to one of these three
  // outcomes), not because each individually represents a mutation -- see
  // request-kind.ts's own comment on this set for the same rationale.
  it.each(ONCALL_ACTIONS)("%s classifies as write", (action) => {
    expect(classifyRequestKind(action)).toBe("write");
  });
});
