/**
 * audit log label action strings -- docs/specs/oncall-routing.md T36/R1c.
 *
 * Confirms the two new label.* AuditAction values are wired into every
 * exhaustiveness map in the same commit as the DB CHECK constraint
 * (migration 0098_admin_audit_log_label_actions.sql).
 */

import { describe, it, expect } from "vitest";
import { classifyOutcome, ALL_AUDIT_ACTIONS } from "./outcome.js";
import { classifyRequestKind } from "./request-kind.js";

const LABEL_ACTIONS = ["label.assigned", "label.removed"] as const;

describe("audit log label action strings", () => {
  it.each(LABEL_ACTIONS)("%s is a recognized AuditAction value", (action) => {
    expect(ALL_AUDIT_ACTIONS).toContain(action);
  });

  it.each(LABEL_ACTIONS)(
    "%s classifies as allowed -- ordinary successful mutations, not access denials",
    (action) => {
      expect(classifyOutcome(action)).toBe("allowed");
    },
  );

  it.each(LABEL_ACTIONS)("%s classifies as write", (action) => {
    expect(classifyRequestKind(action)).toBe("write");
  });
});
