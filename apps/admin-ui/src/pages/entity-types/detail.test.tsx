import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// docs/specs/mandatory-ticket-fields.md R1: a system field (every workflow's title) is
// protected -- the API refuses to edit or delete it, so the page offers neither.

vi.mock("@refinedev/core", () => ({
  useOne: () => ({
    result: {
      id: "et-1",
      name: "ticket",
      plural: "Tickets",
      icon: null,
      moduleId: null,
    },
    query: { isLoading: false },
  }),
}));

vi.mock("../../lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (url: string): Promise<unknown> =>
    url === "/api/entity-types/et-1/fields"
      ? Promise.resolve({
          data: [
            {
              id: "f-title",
              name: "title",
              label: "Title",
              fieldType: "text",
              isRequired: true,
              isSystem: true,
              sortOrder: 0,
              config: {},
            },
            {
              id: "f-notes",
              name: "notes",
              label: "Notes",
              fieldType: "text",
              isRequired: false,
              isSystem: false,
              sortOrder: 1,
              config: {},
            },
          ],
        })
      : Promise.resolve({ data: [] }),
}));

vi.mock("../../components/global-alert-dialog.js", () => ({
  showAlert: vi.fn(),
  showConfirm: vi.fn(() => Promise.resolve(false)),
}));

const { EntityTypeDetail } = await import("./detail.js");

describe("EntityTypeDetail — protected fields", () => {
  afterEach(() => cleanup());

  it("offers edit and delete only on fields that aren't system fields", async () => {
    render(
      <MemoryRouter initialEntries={["/entity-types/et-1"]}>
        <Routes>
          <Route path="/entity-types/:id" element={<EntityTypeDetail />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Notes")).toBeDefined();
    expect(screen.getByText("Title")).toBeDefined();
    expect(screen.getAllByTitle("Edit field")).toHaveLength(1);
    expect(screen.getAllByTitle("Delete field")).toHaveLength(1);
  });
});
