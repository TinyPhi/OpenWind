import { describe, it, expect } from "vitest";
import {
  fromApiActions,
  stateKeyFor,
  toApiActions,
  withConfigValues,
} from "./payload.js";
import type { ActionItem } from "./types.js";

describe("stateKeyFor", () => {
  it("uses toState for a state-entered trigger, matching the API schema", () => {
    expect(stateKeyFor("workflow.entered_state")).toBe("toState");
  });

  it("uses state for an SLA breach, which the executor reads", () => {
    expect(stateKeyFor("workflow.sla_breached")).toBe("state");
  });
});

describe("withConfigValues", () => {
  it("sets a chosen value", () => {
    expect(withConfigValues({}, { workflowId: "wf-1" })).toEqual({
      workflowId: "wf-1",
    });
  });

  it("removes a key when a placeholder option sends an empty string", () => {
    expect(
      withConfigValues(
        { workflowId: "wf-1", toState: "open" },
        { toState: "" },
      ),
    ).toEqual({ workflowId: "wf-1" });
  });

  it("clears a dependent key while setting its parent", () => {
    expect(
      withConfigValues(
        { entityTypeId: "et-1", field: "status" },
        { entityTypeId: "et-2", field: "" },
      ),
    ).toEqual({ entityTypeId: "et-2" });
  });

  it("does not mutate the original config", () => {
    const config = { toState: "open" };
    withConfigValues(config, { toState: "" });
    expect(config).toEqual({ toState: "open" });
  });
});

const webhook = (headers: unknown): ActionItem => ({
  id: "a-1",
  type: "webhook",
  config: { url: "https://example.com/hook", headers },
});

describe("toApiActions", () => {
  it("drops the local id from every action", () => {
    const [saved] = toApiActions([
      { id: "a-1", type: "set_field", config: { field: "status", value: "x" } },
    ]);
    expect(saved).toEqual({
      type: "set_field",
      config: { field: "status", value: "x" },
    });
  });

  it("saves webhook header rows as a name-to-value record", () => {
    const [saved] = toApiActions([
      webhook([
        { key: "X-Token", value: "abc" },
        { key: " X-Env ", value: "prod" },
      ]),
    ]);
    expect(saved?.config.headers).toEqual({
      "X-Token": "abc",
      "X-Env": "prod",
    });
  });

  it("skips header rows with no name and omits headers when none remain", () => {
    const [saved] = toApiActions([webhook([{ key: " ", value: "orphan" }])]);
    expect(saved?.config).toEqual({ url: "https://example.com/hook" });
  });
});

describe("fromApiActions", () => {
  it("turns a stored header record back into editable rows", () => {
    const [loaded] = fromApiActions(
      [
        {
          type: "webhook",
          config: { url: "https://example.com/hook", headers: { "X-A": "1" } },
        },
      ],
      () => "new-id",
    );
    expect(loaded).toEqual({
      id: "new-id",
      type: "webhook",
      config: {
        url: "https://example.com/hook",
        headers: [{ key: "X-A", value: "1" }],
      },
    });
  });

  it("round-trips webhook headers through save and load", () => {
    const rows = [{ key: "X-A", value: "1" }];
    const saved = toApiActions([webhook(rows)]);
    const [loaded] = fromApiActions(saved, () => "a-1");
    expect(loaded?.config.headers).toEqual(rows);
  });
});
