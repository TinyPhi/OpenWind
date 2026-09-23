/**
 * audit log reporting action strings -- docs/specs/byoq-hardening.md.
 *
 * Confirms the two new reporting.* AuditAction values are wired into every
 * exhaustiveness map, matching migration 0115_reporting_audit_trail.sql's
 * DB CHECK constraint (which also reserves "reporting.exported", not yet
 * called from anywhere TS-side).
 */

import { describe, it, expect } from "vitest";
import { classifyOutcome, ALL_AUDIT_ACTIONS } from "./outcome.js";
import { classifyRequestKind } from "./request-kind.js";

const REPORTING_ACTIONS = [
  "reporting.query_executed",
  "reporting.query_failed",
] as const;

describe("audit log reporting action strings", () => {
  it.each(REPORTING_ACTIONS)(
    "%s is a recognized AuditAction value",
    (action) => {
      expect(ALL_AUDIT_ACTIONS).toContain(action);
    },
  );

  it.each(REPORTING_ACTIONS)(
    "%s classifies as allowed -- a failed query is a runtime error, not a denied caller request",
    (action) => {
      expect(classifyOutcome(action)).toBe("allowed");
    },
  );

  it.each(REPORTING_ACTIONS)("%s classifies as read", (action) => {
    expect(classifyRequestKind(action)).toBe("read");
  });
});
