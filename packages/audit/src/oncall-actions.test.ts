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

  it.each(ONCALL_ACTIONS)("%s classifies as write", (action) => {
    expect(classifyRequestKind(action)).toBe("write");
  });
});
