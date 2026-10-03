/**
 * #638 / #693 export.* AuditAction values are wired into every exhaustiveness
 * map, matching migrations 0127 and 0131's CHECK constraint.
 */

import { describe, it, expect } from "vitest";
import { classifyOutcome, ALL_AUDIT_ACTIONS } from "./outcome.js";
import { classifyRequestKind } from "./request-kind.js";

const EXPORT_ACTIONS = [
  "export.requested",
  "export.completed",
  "export.failed",
  "export.downloaded",
  "export.download_denied",
] as const;

describe("audit log export action strings", () => {
  it.each(EXPORT_ACTIONS)("%s is a recognized AuditAction value", (action) => {
    expect(ALL_AUDIT_ACTIONS).toContain(action);
  });

  it.each(EXPORT_ACTIONS)("%s classifies as read", (action) => {
    expect(classifyRequestKind(action)).toBe("read");
  });

  it.each([
    "export.requested",
    "export.completed",
    "export.failed",
    "export.downloaded",
  ] as const)("%s classifies as allowed", (action) => {
    expect(classifyOutcome(action)).toBe("allowed");
  });

  it("export.download_denied classifies as denied", () => {
    expect(classifyOutcome("export.download_denied")).toBe("denied");
  });
});
