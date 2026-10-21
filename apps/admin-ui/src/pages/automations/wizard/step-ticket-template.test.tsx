import React, { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const mockFetchWithAuth = vi.fn<(url: string) => Promise<unknown>>();
vi.mock("../../../lib/api.js", () => ({
  API_URL: "",
  fetchWithAuth: (url: string) => mockFetchWithAuth(url),
}));

const { StepActions } = await import("./step-actions.js");
const { EMPTY_WIZARD } = await import("./types.js");
const { clearUsersCache } = await import("../../../lib/use-users.js");
import type { WizardData } from "./types.js";

// docs/specs/mandatory-ticket-fields.md R7: the "Create ticket" / "Create sub-task" template.
const PERSON = "395069484982861826";

function mockOptions(): void {
  mockFetchWithAuth.mockImplementation((url: string) => {
    if (url.startsWith("/workflows")) {
      return Promise.resolve({
        data: [{ id: "wf-1", name: "Support", entityTypeId: "et-1" }],
      });
    }
    if (url === "/admin/teams") {
      return Promise.resolve({ data: [{ id: "team-1", name: "Platform" }] });
    }
    if (url === "/users") {
      return Promise.resolve({
        data: [{ userId: PERSON, displayName: "Asha", email: "a@x.io" }],
      });
    }
    return Promise.resolve({ data: [] });
  });
}

function withAction(
  type: WizardData["actions"][number]["type"],
  config: Record<string, unknown>,
): WizardData {
  return { ...EMPTY_WIZARD, actions: [{ id: "a1", type, config }] };
}

// Feeds each change back in, as the wizard does, so the form sees its own edits.
function Harness({
  initial,
  onChange,
}: {
  initial: WizardData;
  onChange: (patch: Partial<WizardData>) => void;
}): React.ReactElement {
  const [data, setData] = useState(initial);
  return (
    <StepActions
      data={data}
      onChange={(patch) => {
        onChange(patch);
        setData((d) => ({ ...d, ...patch }));
      }}
      transitions={{ status: "no-workflow" }}
    />
  );
}

function renderStep(data: WizardData): ReturnType<typeof vi.fn> {
  const onChange = vi.fn();
  render(<Harness initial={data} onChange={onChange} />);
  return onChange;
}

function lastConfig(
  onChange: ReturnType<typeof vi.fn>,
): Record<string, unknown> {
  // StepActions reports the whole actions list; the test has one action.
  const patch = onChange.mock.calls.at(-1)?.[0] as WizardData;
  return patch.actions[0]?.config ?? {};
}

afterEach(() => {
  cleanup();
  mockFetchWithAuth.mockReset();
  clearUsersCache();
});

describe("StepActions — ticket template actions", () => {
  it("starts a new Create ticket action from the defaults", () => {
    mockOptions();
    const onChange = renderStep(withAction("notify", {}));

    fireEvent.change(screen.getByDisplayValue("Send notification"), {
      target: { value: "create_entity" },
    });

    expect(onChange).toHaveBeenCalledWith({
      actions: [
        {
          id: "a1",
          type: "create_entity",
          config: { template: { due_days: 3, severity: "medium" } },
        },
      ],
    });
  });

  it("sets the workflow's entity type and keeps settings the form doesn't show", async () => {
    mockOptions();
    const onChange = renderStep(
      withAction("create_entity", {
        fields: { priority: "high" },
        template: { due_days: 3, severity: "medium" },
      }),
    );

    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Support" })).toBeDefined(),
    );
    fireEvent.change(screen.getByLabelText("Workflow"), {
      target: { value: "wf-1" },
    });

    expect(lastConfig(onChange)).toEqual({
      entityTypeId: "et-1",
      fields: { priority: "high" },
      template: { due_days: 3, severity: "medium" },
    });
  });

  it("assigns a person or a team, never both", async () => {
    mockOptions();
    const onChange = renderStep(
      withAction("create_child", {
        writeBackField: "follow_up_id",
        template: { due_days: 3, severity: "medium", teamId: "team-1" },
      }),
    );

    expect(
      (screen.getByLabelText("Assign to") as HTMLSelectElement).value,
    ).toBe("team");
    fireEvent.change(screen.getByLabelText("Assign to"), {
      target: { value: "user" },
    });
    expect(lastConfig(onChange)).toEqual({
      writeBackField: "follow_up_id",
      template: { due_days: 3, severity: "medium" },
    });

    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Asha" })).toBeDefined(),
    );
    fireEvent.change(screen.getByLabelText("Person"), {
      target: { value: PERSON },
    });
    expect(lastConfig(onChange)).toMatchObject({
      template: { assignedTo: PERSON },
    });
  });

  it("shows the team picker when a saved rule's team arrives after the form opened", () => {
    mockOptions();
    const props = {
      onChange: vi.fn(),
      transitions: { status: "no-workflow" } as const,
    };
    const { rerender } = render(
      <StepActions
        data={withAction("create_entity", { template: {} })}
        {...props}
      />,
    );
    expect(
      (screen.getByLabelText("Assign to") as HTMLSelectElement).value,
    ).toBe("owner");

    rerender(
      <StepActions
        data={withAction("create_entity", {
          template: { due_days: 3, severity: "medium", teamId: "team-1" },
        })}
        {...props}
      />,
    );
    expect(
      (screen.getByLabelText("Assign to") as HTMLSelectElement).value,
    ).toBe("team");
    expect(screen.getByLabelText("Team")).toBeDefined();
  });

  it("says when a list couldn't load instead of showing it empty", async () => {
    mockFetchWithAuth.mockImplementation((url: string) =>
      url.startsWith("/workflows")
        ? Promise.reject(new Error("Network error"))
        : Promise.resolve({ data: [] }),
    );
    renderStep(withAction("create_entity", { template: {} }));

    expect(screen.getByRole("option", { name: "Loading…" })).toBeDefined();
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /Couldn't load the workflows/,
      ),
    );
    expect(
      screen.getByRole("option", { name: "Select a workflow…" }),
    ).toBeDefined();
  });

  it("shows what a blank title and remark default to", () => {
    mockOptions();
    renderStep(withAction("create_child", { template: {} }));

    expect(
      screen.getByPlaceholderText("<rule name>: <parent ticket title>"),
    ).toBeDefined();
    expect(
      screen.getByPlaceholderText("Created by automation: <rule name>"),
    ).toBeDefined();
    expect(screen.getByRole("status").textContent).toMatch(/whole number/);
  });
});
