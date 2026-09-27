import { describe, it, expect, vi } from "vitest";
import { ruleInScope } from "./trigger-scope.js";
import type { TriggerEvent } from "./event-schemas.js";

const WF = "11111111-1111-4111-8111-111111111111";
const OTHER_WF = "22222222-2222-4222-8222-222222222222";
const TICKET = "33333333-3333-4333-8333-333333333333";
const ORDER = "44444444-4444-4444-8444-444444444444";

// Test fixtures only need the fields ruleInScope reads.
const transitioned = (over: Record<string, unknown> = {}): TriggerEvent =>
  ({
    eventType: "workflow.transitioned",
    workflowId: WF,
    entityTypeId: TICKET,
    fromState: "open",
    toState: "approved",
    ...over,
  }) as unknown as TriggerEvent;

const created = (entityTypeId?: string): TriggerEvent =>
  ({ eventType: "entity.created", entityTypeId }) as unknown as TriggerEvent;

const names = vi.fn(async (id: string) =>
  id === TICKET ? "ticket" : id === ORDER ? "order" : null,
);

describe("ruleInScope", () => {
  it("matches everything for an empty, null or missing config", async () => {
    expect(await ruleInScope({}, transitioned(), names)).toBe(true);
    expect(await ruleInScope(null, transitioned(), names)).toBe(true);
    expect(await ruleInScope(undefined, created(ORDER), names)).toBe(true);
  });

  it("treats empty strings and nulls as 'any'", async () => {
    const config = { workflowId: "", toState: null, entityType: "" };
    expect(await ruleInScope(config, transitioned(), names)).toBe(true);
  });

  it("filters workflow.transitioned by workflowId, fromState and toState", async () => {
    expect(
      await ruleInScope(
        { workflowId: WF },
        transitioned({ workflowId: OTHER_WF }),
        names,
      ),
    ).toBe(false);
    expect(
      await ruleInScope({ toState: "closed" }, transitioned(), names),
    ).toBe(false);
    expect(
      await ruleInScope({ fromState: "review" }, transitioned(), names),
    ).toBe(false);
    expect(
      await ruleInScope(
        { workflowId: WF, fromState: "open", toState: "approved" },
        transitioned(),
        names,
      ),
    ).toBe(true);
  });

  it("filters sla_breached by state, not toState", async () => {
    const breach = {
      eventType: "workflow.sla_breached",
      workflowId: WF,
      state: "legal_review",
    } as unknown as TriggerEvent;
    expect(await ruleInScope({ state: "legal_review" }, breach, names)).toBe(
      true,
    );
    expect(await ruleInScope({ state: "draft" }, breach, names)).toBe(false);
  });

  it("filters entity events by entityTypeId", async () => {
    expect(
      await ruleInScope({ entityTypeId: TICKET }, created(TICKET), names),
    ).toBe(true);
    expect(
      await ruleInScope({ entityTypeId: TICKET }, created(ORDER), names),
    ).toBe(false);
  });

  it("matches the legacy {entityType: name} form by the event entity type's name", async () => {
    expect(
      await ruleInScope({ entityType: "ticket" }, created(TICKET), names),
    ).toBe(true);
    expect(
      await ruleInScope({ entityType: "ticket" }, created(ORDER), names),
    ).toBe(false);
    // unknown to this tenant's resolver
    expect(
      await ruleInScope({ entityType: "ticket" }, created(OTHER_WF), names),
    ).toBe(false);
  });

  it("matches the entityType name case-insensitively", async () => {
    expect(
      await ruleInScope({ entityType: "Ticket" }, created(TICKET), names),
    ).toBe(true);
    expect(
      await ruleInScope({ entityType: "TICKET" }, created(ORDER), names),
    ).toBe(false);
  });

  it("does not match a set key when the event lacks that field", async () => {
    expect(
      await ruleInScope({ entityTypeId: TICKET }, created(undefined), names),
    ).toBe(false);
    expect(
      await ruleInScope({ entityType: "ticket" }, created(undefined), names),
    ).toBe(false);
  });

  it("compares ids case-insensitively but state names exactly", async () => {
    expect(
      await ruleInScope(
        { workflowId: WF.toUpperCase() },
        transitioned(),
        names,
      ),
    ).toBe(true);
    expect(
      await ruleInScope(
        { entityTypeId: TICKET.toUpperCase() },
        created(TICKET),
        names,
      ),
    ).toBe(true);
    expect(
      await ruleInScope({ toState: "Approved" }, transitioned(), names),
    ).toBe(false);
  });

  it("ignores keys that aren't defined for the trigger type", async () => {
    expect(
      await ruleInScope(
        { fieldName: "priority", toState: "x" },
        created(TICKET),
        names,
      ),
    ).toBe(true);
  });

  it("does not consult the name resolver unless entityType is set", async () => {
    names.mockClear();
    await ruleInScope({ entityTypeId: TICKET }, created(TICKET), names);
    expect(names).not.toHaveBeenCalled();
  });
});
