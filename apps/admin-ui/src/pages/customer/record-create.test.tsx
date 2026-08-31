import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import "../../i18n.js";

const fetchWithAuth = vi.fn();
vi.mock("../../lib/api.js", () => ({
  fetchWithAuth: (...args: unknown[]): unknown => fetchWithAuth(...args),
  API_URL: "/api",
}));

vi.mock("../../entity-type-context.js", () => ({
  useEntityTypes: () => ({
    entityTypes: [
      {
        id: "et-1",
        name: "ticket",
        plural: "Tickets",
        icon: null,
        moduleId: null,
      },
    ],
    modules: [],
    getTypeBySlug: () => ({
      id: "et-1",
      name: "ticket",
      plural: "Tickets",
      icon: null,
      moduleId: null,
    }),
    getTypeById: () => ({
      id: "et-1",
      name: "ticket",
      plural: "Tickets",
      icon: null,
      moduleId: null,
    }),
    reload: () => {},
  }),
}));

vi.mock("../../hooks/use-file-upload.js", () => ({
  useFileUpload: () => ({
    stagedFiles: [],
    addFiles: vi.fn(),
    removeFile: vi.fn(),
    pendingCount: 0,
    cleanFileIds: [],
  }),
}));

const { CustomerRecordCreate } = await import("./record-create.js");

const FIELDS = [
  {
    id: "f-title",
    name: "title",
    label: "Title",
    fieldType: "text",
    isRequired: true,
    isSystem: false,
    config: {},
  },
];

function renderAt(state: Record<string, unknown>): ReturnType<typeof render> {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url.includes("/fields")) return Promise.resolve({ data: FIELDS });
    if (url.includes("/workflows")) return Promise.resolve({ data: [] });
    if (url.includes("/users")) return Promise.resolve({ data: [] });
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });

  return render(
    <MemoryRouter
      initialEntries={[{ pathname: "/records/tickets/new", state }]}
    >
      <Routes>
        <Route
          path="/records/:typeSlug/new"
          element={<CustomerRecordCreate />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function titleInput(): HTMLInputElement {
  const label = screen.getByText("Title");
  const group = label.closest(".portal-field-group");
  if (!group) throw new Error("field group not found");
  const input = group.querySelector("input");
  if (!input) throw new Error("input not found");
  return input;
}

describe("CustomerRecordCreate — hosted ticket-create handoff prefill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // spec R1/T4 -- prefillFields seeds fieldValues once the field schema loads.
  it("seeds fieldValues from routeState.prefillFields, keyed by field name", async () => {
    renderAt({
      entityTypeId: "et-1",
      workflowId: "wf-1",
      prefillFields: { title: "Client dinner" },
    });

    await waitFor(() => {
      expect(titleInput().value).toBe("Client dinner");
    });
  });

  // spec R3/T7 -- landing on a pre-filled form must never itself create the
  // ticket; only an explicit user submit may call the create endpoint.
  it("does not call POST /entities on mount, even with prefillFields present", async () => {
    renderAt({
      entityTypeId: "et-1",
      workflowId: "wf-1",
      prefillFields: { title: "Client dinner" },
    });

    await waitFor(() => {
      expect(titleInput().value).toBe("Client dinner");
    });
    expect(fetchWithAuth).not.toHaveBeenCalledWith(
      "/api/entities",
      expect.objectContaining({ method: "POST" }),
    );
  });

  // No prefillFields at all -- existing behavior (empty form) must be unaffected.
  it("with no prefillFields, fieldValues stays empty as before", async () => {
    renderAt({ entityTypeId: "et-1", workflowId: "wf-1" });

    await waitFor(() => {
      expect(screen.getByText("Title")).toBeDefined();
    });
    expect(titleInput().value).toBe("");
  });
});
