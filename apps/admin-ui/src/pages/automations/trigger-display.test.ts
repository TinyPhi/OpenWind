import { describe, it, expect } from "vitest";
import { isRetiredTrigger, triggerLabel } from "./trigger-display.js";

describe("triggerLabel", () => {
  it("names a field-scoped update 'Field changed'", () => {
    expect(triggerLabel("entity.updated", { field: "status" })).toBe(
      "Field changed",
    );
  });

  it("names an unscoped update 'Record updated'", () => {
    expect(triggerLabel("entity.updated", {})).toBe("Record updated");
    expect(triggerLabel("entity.updated", undefined)).toBe("Record updated");
  });

  it("keeps a readable label for retired types still stored as disabled rules", () => {
    expect(triggerLabel("schedule.cron", {})).toBe("Scheduled");
  });

  it("falls back to the raw type for one it doesn't know", () => {
    expect(triggerLabel("comment.mentioned", {})).toBe("comment.mentioned");
  });
});

describe("isRetiredTrigger", () => {
  it.each([
    "workflow.entered_state",
    "field.changed",
    "schedule.cron",
    "connector.event",
  ])("marks %s as retired", (type) => {
    expect(isRetiredTrigger(type)).toBe(true);
  });

  it("does not mark a supported type as retired", () => {
    expect(isRetiredTrigger("entity.updated")).toBe(false);
    expect(isRetiredTrigger("comment.mentioned")).toBe(false);
  });
});
