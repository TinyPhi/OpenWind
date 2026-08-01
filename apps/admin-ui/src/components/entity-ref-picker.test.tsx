import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";

vi.mock("../lib/api.js", () => ({ fetchWithAuth: vi.fn(), API_URL: "" }));
vi.mock("../entity-type-context.js", () => ({
  useEntityTypes: () => ({
    entityTypes: [
      {
        id: "type-1",
        name: "ticket",
        plural: "Tickets",
        icon: null,
        moduleId: null,
      },
    ],
  }),
}));

const api = await import("../lib/api.js");
const fetchWithAuth = vi.mocked(api.fetchWithAuth);
const { EntityRefPicker } = await import("./entity-ref-picker.js");

beforeEach(() => {
  fetchWithAuth.mockReset();
});

afterEach(() => cleanup());

describe("EntityRefPicker", () => {
  it("shows an unknown-type placeholder when target_entity_type doesn't resolve", () => {
    render(
      <EntityRefPicker
        targetEntityTypeName="nonexistent"
        value={null}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByDisplayValue("Unknown entity type: nonexistent"),
    ).not.toBeNull();
  });

  it("resolves and displays the selected instance's label via GET /entities/:id", async () => {
    fetchWithAuth.mockResolvedValue({
      data: { id: "e1", fields: { title: "Fix the widget" } },
    });
    render(
      <EntityRefPicker
        targetEntityTypeName="ticket"
        value="e1"
        onChange={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("button").textContent).toBe("Fix the widget");
    });
    expect(fetchWithAuth).toHaveBeenCalledWith("/entities/e1");
  });

  it("searches on query change and calls onChange with the picked instance id", async () => {
    fetchWithAuth.mockResolvedValue({
      data: { data: [{ id: "e2", fields: { name: "Acme Corp" } }] },
    });
    const onChange = vi.fn();
    render(
      <EntityRefPicker
        targetEntityTypeName="ticket"
        value={null}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select…" }));
    fireEvent.change(screen.getByPlaceholderText("Search tickets…"), {
      target: { value: "acme" },
    });
    await waitFor(() => screen.getByText("Acme Corp"), { timeout: 1000 });
    fireEvent.click(screen.getByText("Acme Corp"));
    expect(onChange).toHaveBeenCalledWith("e2");
  });
});
