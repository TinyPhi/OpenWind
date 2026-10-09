import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const mockFetchWithAuth = vi.fn<(url: string) => Promise<unknown>>();
vi.mock("../../../lib/api.js", () => ({
  API_URL: "",
  fetchWithAuth: (url: string) => mockFetchWithAuth(url),
}));

const { StepTrigger } = await import("./step-trigger.js");
const { EMPTY_WIZARD } = await import("./types.js");
import type { WizardData } from "./types.js";

afterEach(() => {
  cleanup();
  mockFetchWithAuth.mockReset();
});

function mockApi(): void {
  mockFetchWithAuth.mockImplementation((url: string) => {
    if (url.endsWith("/entity-types")) {
      return Promise.resolve({
        data: [{ id: "et-1", name: "ticket", plural: "Tickets" }],
      });
    }
    return Promise.resolve({
      data: [{ id: "f-1", name: "priority", label: "Priority" }],
    });
  });
}

function fieldChanged(config: Record<string, unknown>): WizardData {
  return {
    ...EMPTY_WIZARD,
    triggerType: "field.changed",
    triggerConfig: config,
  };
}

describe("StepTrigger — 'any field' warning (#767)", () => {
  it("warns that the rule fires on every update when no field is picked", async () => {
    mockApi();
    render(
      <StepTrigger
        data={fieldChanged({ entityTypeId: "et-1" })}
        onChange={vi.fn()}
      />,
    );

    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("every update to every ticket record");
  });

  it("hides the warning once a field is picked", async () => {
    mockApi();
    render(
      <StepTrigger
        data={fieldChanged({ entityTypeId: "et-1", field: "priority" })}
        onChange={vi.fn()}
      />,
    );

    await screen.findByText("Priority");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("shows no warning before an entity type is chosen", async () => {
    mockApi();
    render(<StepTrigger data={fieldChanged({})} onChange={vi.fn()} />);

    await screen.findByText("Entity Type");
    expect(screen.queryByRole("note")).toBeNull();
  });
});
