/**
 * Audit log reporting action strings.
 *
 * Confirms the reporting.* AuditAction values are wired into every
 * exhaustiveness map. They are exactly the reporting actions migration
 * 0115_reporting_audit_trail.sql's CHECK constraint admits: query and export
 * events written by Superset through record_reporting_audit(), and guest-pass
 * events written by the reporting API.
 */

import { describe, it, expect } from "vitest";
import { classifyOutcome, ALL_AUDIT_ACTIONS } from "./outcome.js";
import { classifyRequestKind } from "./request-kind.js";

const REPORTING_ACTIONS = [
  "reporting.query_executed",
  "reporting.exported",
  "reporting.guest_token_issued",
] as const;

describe("audit log reporting action strings", () => {
  it.each(REPORTING_ACTIONS)(
    "%s is a recognized AuditAction value",
    (action) => {
      expect(ALL_AUDIT_ACTIONS).toContain(action);
    },
  );

  it.each(REPORTING_ACTIONS)(
    "%s classifies as allowed -- it records something that happened, not a refused request",
    (action) => {
      expect(classifyOutcome(action)).toBe("allowed");
    },
  );

  it.each(REPORTING_ACTIONS)("%s classifies as read", (action) => {
    expect(classifyRequestKind(action)).toBe("read");
  });
});

describe("reporting.guest_token_denied", () => {
  it("is a recognized AuditAction value", () => {
    expect(ALL_AUDIT_ACTIONS).toContain("reporting.guest_token_denied");
  });

  it("classifies as denied -- the caller's role did not entitle them", () => {
    expect(classifyOutcome("reporting.guest_token_denied")).toBe("denied");
  });

  it("classifies as read", () => {
    expect(classifyRequestKind("reporting.guest_token_denied")).toBe("read");
  });
});
