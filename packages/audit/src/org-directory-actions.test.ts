/**
 * #745 / #754 org_directory.* AuditAction values are wired into every
 * exhaustiveness map, matching migration 0134's CHECK constraint.
 */

import { describe, it, expect } from "vitest";
import { classifyOutcome, ALL_AUDIT_ACTIONS } from "./outcome.js";
import { classifyRequestKind } from "./request-kind.js";

const ORG_DIRECTORY_ACTIONS = [
  "org_directory.sync_completed",
  "org_directory.sync_failed",
] as const;

describe("audit log org-directory action strings", () => {
  it.each(ORG_DIRECTORY_ACTIONS)(
    "%s is a recognized AuditAction value",
    (action) => {
      expect(ALL_AUDIT_ACTIONS).toContain(action);
    },
  );

  it.each(ORG_DIRECTORY_ACTIONS)("%s classifies as write", (action) => {
    expect(classifyRequestKind(action)).toBe("write");
  });

  it.each(ORG_DIRECTORY_ACTIONS)("%s classifies as allowed", (action) => {
    expect(classifyOutcome(action)).toBe("allowed");
  });

  it("no longer recognizes the bare legacy sync_failed value", () => {
    expect(ALL_AUDIT_ACTIONS).not.toContain("sync_failed");
  });
});
