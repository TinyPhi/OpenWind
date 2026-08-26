/**
 * outcome.test.ts — AuditAction -> allowed/denied classification.
 */

import { describe, it, expect } from "vitest";
import {
  classifyOutcome,
  actionsForOutcome,
  ALL_AUDIT_ACTIONS,
} from "./outcome.js";
import type { AuditAction } from "./index.js";

const ALL_ACTIONS: readonly AuditAction[] = ALL_AUDIT_ACTIONS;

const DENIED: AuditAction[] = [
  "tag.misuse_rate_capped",
  "transition.access_denied",
  "comment.access_denied",
  "child.access_denied",
  "attachment.reference_denied",
];

describe("classifyOutcome", () => {
  it.each(DENIED)("classifies %s as denied", (action) => {
    expect(classifyOutcome(action)).toBe("denied");
  });

  it.each(ALL_ACTIONS.filter((a) => !DENIED.includes(a)))(
    "classifies %s as allowed",
    (action) => {
      expect(classifyOutcome(action)).toBe("allowed");
    },
  );

  it("covers every AuditAction value with no unmapped fallthrough", () => {
    for (const action of ALL_ACTIONS) {
      expect(["allowed", "denied"]).toContain(classifyOutcome(action));
    }
  });
});

describe("actionsForOutcome", () => {
  it("returns exactly the denied actions for 'denied'", () => {
    expect(new Set(actionsForOutcome("denied"))).toEqual(new Set(DENIED));
  });

  it("returns exactly the non-denied actions for 'allowed'", () => {
    const expected = ALL_ACTIONS.filter((a) => !DENIED.includes(a));
    expect(new Set(actionsForOutcome("allowed"))).toEqual(new Set(expected));
  });
});
