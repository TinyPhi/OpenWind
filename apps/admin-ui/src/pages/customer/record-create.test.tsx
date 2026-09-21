import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import "../../i18n.js";

const fetchWithAuth =
  vi.fn<(url: string, opts?: RequestInit | undefined) => Promise<unknown>>();
vi.mock("../../lib/api.js", () => ({
  fetchWithAuth: (url: string, opts?: RequestInit): unknown =>
    fetchWithAuth(url, opts),
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

const FIELDS_WITH_OPTIONAL = [
  ...FIELDS,
  {
    id: "f-notes",
    name: "notes",
    label: "Notes",
    fieldType: "text",
    isRequired: false,
    isSystem: false,
    config: {},
  },
];

function renderAt(
  state: Record<string, unknown>,
  fields = FIELDS,
  teams: Array<{ id: string; name: string }> = [TEST_TEAM],
): ReturnType<typeof render> {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url.includes("/fields")) return Promise.resolve({ data: fields });
    if (url.includes("/workflows")) return Promise.resolve({ data: [] });
    if (url.includes("/admin/teams")) return Promise.resolve({ data: teams });
    if (url.includes("/users")) return Promise.resolve({ data: [TEST_USER] });
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

// assignedTo/dueDate/remark are mandatory (platform-wide invariant) as of
// the tracking-only mandatory-fields sync -- fill all three before
// submitting in tests unrelated to that guard itself.
const TEST_USER = {
  userId: "u-1",
  displayName: "Test Assignee",
  loginName: "test-assignee",
  email: "assignee@example.com",
};

// docs/specs/team-assign-oncall-fallback.md R1 fixture.
const TEST_TEAM = { id: "team-1", name: "Platform Engineering" };

async function fillMandatoryFields(): Promise<void> {
  fireEvent.click(screen.getByText("Search and assign a user…"));
  const option = await screen.findByText(TEST_USER.displayName);
  fireEvent.click(option);

  const dueDateLabel = screen.getByText("Due Date");
  const dueDateGroup = dueDateLabel.closest(".portal-field-group");
  if (!dueDateGroup) throw new Error("due date field group not found");
  const dueDateInput = dueDateGroup.querySelector("input");
  if (!dueDateInput) throw new Error("due date input not found");
  fireEvent.change(dueDateInput, { target: { value: "2026-01-01T09:00" } });

  const remarkLabel = screen.getByText("Remark");
  const remarkGroup = remarkLabel.closest(".portal-field-group");
  if (!remarkGroup) throw new Error("remark field group not found");
  const remarkInput = remarkGroup.querySelector("textarea");
  if (!remarkInput) throw new Error("remark input not found");
  fireEvent.change(remarkInput, { target: { value: "a remark" } });
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

describe("CustomerRecordCreate — Mandate/Other tabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows required custom fields (title) on the Mandate tab and optional ones only on Other", async () => {
    renderAt(
      { entityTypeId: "et-1", workflowId: "wf-1" },
      FIELDS_WITH_OPTIONAL,
    );

    await waitFor(() => {
      expect(screen.getByText("Mandate")).toBeDefined();
    });

    expect(screen.getByText("Title")).toBeDefined();
    expect(screen.queryByText("Notes")).toBeNull();

    fireEvent.click(screen.getByText("Other"));
    await waitFor(() => {
      expect(screen.getByText("Notes")).toBeDefined();
    });
    expect(screen.queryByText("Title")).toBeNull();
  });

  // docs/specs/team-assign-oncall-fallback.md R2 -- team_id is a real,
  // optional entity field (excluded from the generic Other-tab list) once
  // this ships, so the fixture below simulates that shape directly.
  it("never shows team_id in the Other tab, even though it's a real optional field", async () => {
    const FIELDS_WITH_TEAM_ID = [
      ...FIELDS,
      {
        id: "f-team-id",
        name: "team_id",
        label: "Team",
        fieldType: "text",
        isRequired: false,
        isSystem: false,
        config: {},
      },
    ];
    renderAt({ entityTypeId: "et-1", workflowId: "wf-1" }, FIELDS_WITH_TEAM_ID);

    await waitFor(() => {
      expect(screen.getByText("Mandate")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Other"));
    await waitFor(() => {
      expect(
        screen.getByText("No other fields defined for this entity type."),
      ).toBeDefined();
    });
  });
});

// docs/specs/team-assign-oncall-fallback.md R1 -- User/Team assign-mode
// toggle, exactly one required.
describe("CustomerRecordCreate — User/Team assign-mode toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("defaults to User mode, showing the UserPicker", async () => {
    renderAt({ entityTypeId: "et-1", workflowId: "wf-1" });

    await waitFor(() => {
      expect(screen.getByText("Search and assign a user…")).toBeDefined();
    });
  });

  it("switches to Team mode, showing the team picker instead of the user picker", async () => {
    renderAt({ entityTypeId: "et-1", workflowId: "wf-1" });

    await waitFor(() => {
      expect(screen.getByText("Search and assign a user…")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Team"));

    await waitFor(() => {
      expect(screen.getByText("Select a team…")).toBeDefined();
    });
    expect(screen.queryByText("Search and assign a user…")).toBeNull();
  });

  it("blocks submit with a team-specific error when Team mode has no team selected", async () => {
    renderAt({ entityTypeId: "et-1", workflowId: "wf-1" });

    await waitFor(() => {
      expect(screen.getByText("Title")).toBeDefined();
    });

    fireEvent.change(titleInput(), { target: { value: "Some ticket" } });
    fireEvent.click(screen.getByText("Team"));
    fireEvent.click(screen.getByText("Create Ticket"));

    await waitFor(() => {
      expect(
        screen.getByText("Team, Due Date, and Remark are required."),
      ).toBeDefined();
    });
    expect(fetchWithAuth).not.toHaveBeenCalledWith(
      "/api/entities",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("submits with teamId (not assignedTo) once Team mode is filled", async () => {
    renderAt({ entityTypeId: "et-1", workflowId: "wf-1" });

    await waitFor(() => {
      expect(screen.getByText("Title")).toBeDefined();
    });

    fetchWithAuth.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes("/fields")) return Promise.resolve({ data: FIELDS });
      if (url.includes("/workflows")) return Promise.resolve({ data: [] });
      if (url.includes("/admin/teams"))
        return Promise.resolve({ data: [TEST_TEAM] });
      if (url.includes("/users")) return Promise.resolve({ data: [TEST_USER] });
      if (url === "/api/entities" && opts?.method === "POST") {
        return Promise.resolve({ data: { id: "new-ticket-1" } });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    fireEvent.change(titleInput(), { target: { value: "Some ticket" } });
    fireEvent.click(screen.getByText("Team"));
    fireEvent.click(screen.getByText("Select a team…"));
    const teamOption = await screen.findByText(TEST_TEAM.name);
    fireEvent.click(teamOption);

    const dueDateLabel = screen.getByText("Due Date");
    const dueDateGroup = dueDateLabel.closest(".portal-field-group");
    if (!dueDateGroup) throw new Error("due date field group not found");
    const dueDateInput = dueDateGroup.querySelector("input");
    if (!dueDateInput) throw new Error("due date input not found");
    fireEvent.change(dueDateInput, { target: { value: "2026-01-01T09:00" } });

    const remarkLabel = screen.getByText("Remark");
    const remarkGroup = remarkLabel.closest(".portal-field-group");
    if (!remarkGroup) throw new Error("remark field group not found");
    const remarkInput = remarkGroup.querySelector("textarea");
    if (!remarkInput) throw new Error("remark input not found");
    fireEvent.change(remarkInput, { target: { value: "a remark" } });

    fireEvent.click(screen.getByText("Create Ticket"));

    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find(
        ([url, opts]) => url === "/api/entities" && opts?.method === "POST",
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String(call?.[1]?.body)) as {
        assignedTo?: string;
        teamId?: string;
      };
      expect(body.teamId).toBe(TEST_TEAM.id);
      expect(body.assignedTo).toBeUndefined();
    });
  });
});

// assignedTo/dueDate are mandatory (platform-wide invariant, tracking-only
// mandatory-fields sync) -- client-side mirror of the server-side schema.
describe("CustomerRecordCreate — mandatory assignedTo/dueDate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("blocks submit and never calls POST /entities when Assigned To and Due Date are both empty", async () => {
    renderAt({ entityTypeId: "et-1", workflowId: "wf-1" });

    await waitFor(() => {
      expect(screen.getByText("Title")).toBeDefined();
    });

    fireEvent.change(titleInput(), { target: { value: "Some ticket" } });
    fireEvent.click(screen.getByText("Create Ticket"));

    await waitFor(() => {
      expect(
        screen.getByText("Assigned To, Due Date, and Remark are required."),
      ).toBeDefined();
    });
    expect(fetchWithAuth).not.toHaveBeenCalledWith(
      "/api/entities",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("submits successfully once both are filled", async () => {
    renderAt({ entityTypeId: "et-1", workflowId: "wf-1" });

    await waitFor(() => {
      expect(screen.getByText("Title")).toBeDefined();
    });

    fetchWithAuth.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes("/fields")) return Promise.resolve({ data: FIELDS });
      if (url.includes("/workflows")) return Promise.resolve({ data: [] });
      if (url.includes("/admin/teams"))
        return Promise.resolve({ data: [TEST_TEAM] });
      if (url.includes("/users")) return Promise.resolve({ data: [TEST_USER] });
      if (url === "/api/entities" && opts?.method === "POST") {
        return Promise.resolve({ data: { id: "new-ticket-1" } });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    fireEvent.change(titleInput(), { target: { value: "Some ticket" } });
    await fillMandatoryFields();
    fireEvent.click(screen.getByText("Create Ticket"));

    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find(
        ([url, opts]) => url === "/api/entities" && opts?.method === "POST",
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String(call?.[1]?.body)) as {
        assignedTo?: string;
        dueDate?: string;
      };
      expect(body.assignedTo).toBe(TEST_USER.userId);
      expect(body.dueDate).toBeTruthy();
    });
  });
});

// docs/specs/ticket-severity-and-tags.md R1/T12
describe("CustomerRecordCreate — severity field", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("defaults to Medium and submits it unconditionally on create", async () => {
    renderAt({ entityTypeId: "et-1", workflowId: "wf-1" });

    await waitFor(() => {
      expect(screen.getByText("Medium")).toBeDefined();
    });

    fetchWithAuth.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes("/fields")) return Promise.resolve({ data: FIELDS });
      if (url.includes("/workflows")) return Promise.resolve({ data: [] });
      if (url.includes("/admin/teams"))
        return Promise.resolve({ data: [TEST_TEAM] });
      if (url.includes("/users")) return Promise.resolve({ data: [TEST_USER] });
      if (url === "/api/entities" && opts?.method === "POST") {
        return Promise.resolve({ data: { id: "new-ticket-1" } });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    fireEvent.change(titleInput(), { target: { value: "Some ticket" } });
    await fillMandatoryFields();
    fireEvent.click(screen.getByText("Create Ticket"));

    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find(
        ([url, opts]) => url === "/api/entities" && opts?.method === "POST",
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String(call?.[1]?.body)) as {
        severity?: string;
      };
      expect(body.severity).toBe("medium");
    });
  });

  it("submits the changed severity when a different level is selected", async () => {
    renderAt({ entityTypeId: "et-1", workflowId: "wf-1" });

    await waitFor(() => {
      expect(screen.getByText("Medium")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Medium"));
    const criticalOption = await screen.findByRole("button", {
      name: "Critical",
    });
    fireEvent.click(criticalOption);
    await waitFor(() => {
      expect(screen.getByText("Critical")).toBeDefined();
    });

    fetchWithAuth.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes("/fields")) return Promise.resolve({ data: FIELDS });
      if (url.includes("/workflows")) return Promise.resolve({ data: [] });
      if (url.includes("/admin/teams"))
        return Promise.resolve({ data: [TEST_TEAM] });
      if (url.includes("/users")) return Promise.resolve({ data: [TEST_USER] });
      if (url === "/api/entities" && opts?.method === "POST") {
        return Promise.resolve({ data: { id: "new-ticket-1" } });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    fireEvent.change(titleInput(), { target: { value: "Some ticket" } });
    await fillMandatoryFields();
    fireEvent.click(screen.getByText("Create Ticket"));

    await waitFor(() => {
      const call = fetchWithAuth.mock.calls.find(
        ([url, opts]) => url === "/api/entities" && opts?.method === "POST",
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String(call?.[1]?.body)) as {
        severity?: string;
      };
      expect(body.severity).toBe("critical");
    });
  });
});
