/**
 * audit log notification.* and schedule.* action strings --
 * docs/specs/oncall-routing.md T22, docs/specs/temporal-scheduler.md T3.
 *
 * Confirms all 8 new AuditAction values are wired into every exhaustiveness
 * map in the same commit as their DB CHECK constraint extensions
 * (migrations 0100, 0103).
 */

import { describe, it, expect } from "vitest";
import { classifyOutcome, ALL_AUDIT_ACTIONS } from "./outcome.js";
import { classifyRequestKind } from "./request-kind.js";

const NOTIFICATION_ACTIONS = [
  "notification.dispatched",
  "notification.channel_failed",
] as const;

const SCHEDULE_ACTIONS = [
  "schedule.ticket_created",
  "schedule.execution_failed",
  "schedule.execution_skipped",
  "schedule.rule_paused",
  "schedule.rule_resumed",
  "schedule.rule_archived",
] as const;

const ALL_NEW_ACTIONS = [...NOTIFICATION_ACTIONS, ...SCHEDULE_ACTIONS];

describe("audit log notification.* and schedule.* action strings", () => {
  it.each(ALL_NEW_ACTIONS)("%s is a recognized AuditAction value", (action) => {
    expect(ALL_AUDIT_ACTIONS).toContain(action);
  });

  it.each(ALL_NEW_ACTIONS)(
    "%s classifies as allowed -- system/worker outcomes, not denied caller requests",
    (action) => {
      expect(classifyOutcome(action)).toBe("allowed");
    },
  );

  it.each(ALL_NEW_ACTIONS)("%s classifies as write", (action) => {
    expect(classifyRequestKind(action)).toBe("write");
  });
});
