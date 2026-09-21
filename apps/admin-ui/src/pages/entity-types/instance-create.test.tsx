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
    modules: [],
    getTypeById: () => ({
      id: "et-1",
      name: "ticket",
      plural: "Tickets",
      icon: null,
      moduleId: null,
    }),
  }),
  toTypeSlug: (name: string) => name,
}));

const { EntityInstanceCreate } = await import("./instance-create.js");

const TEST_USER = {
  userId: "u-1",
  displayName: "Test Assignee",
  loginName: "test-assignee",
  email: "assignee@example.com",
};

const MANDATE_FIELD = {
  id: "f-title",
  name: "title",
  label: "Title",
  fieldType: "text",
  isRequired: true,
  isSystem: false,
  config: {},
};
const OTHER_FIELD = {
  id: "f-notes",
  name: "notes",
  label: "Notes",
  fieldType: "text",
  isRequired: false,
  isSystem: false,
  config: {},
};

// docs/specs/team-assign-oncall-fallback.md R1 fixture.
const TEST_TEAM = { id: "team-1", name: "Platform Engineering" };

function mockLoad(
  fields = [MANDATE_FIELD, OTHER_FIELD],
  teams: Array<{ id: string; name: string }> = [TEST_TEAM],
): void {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url.endsWith("/entity-types/et-1"))
      return Promise.resolve({
        data: { id: "et-1", name: "ticket", plural: "Tickets" },
      });
    if (url.includes("/fields")) return Promise.resolve({ data: fields });
    if (url.includes("/workflows")) return Promise.resolve({ data: [] });
    if (url.includes("/admin/teams")) return Promise.resolve({ data: teams });
    if (url.includes("/users")) return Promise.resolve({ data: [TEST_USER] });
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

function renderAt(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/entity-types/et-1/instances/new"]}>
      <Routes>
        <Route
          path="/entity-types/:id/instances/new"
          element={<EntityInstanceCreate />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

async function fillMandatoryFields(): Promise<void> {
  fireEvent.click(screen.getByText("Assign to…"));
  const option = await screen.findByText(TEST_USER.displayName);
  fireEvent.click(option);

  const dueDateLabel = screen.getByText("Due Date");
  const dueDateGroup = dueDateLabel.closest(".form-group");
  if (!dueDateGroup) throw new Error("due date field group not found");
  const dueDateInput = dueDateGroup.querySelector("input");
  if (!dueDateInput) throw new Error("due date input not found");
  fireEvent.change(dueDateInput, { target: { value: "2026-01-01T09:00" } });

  const remarkLabel = screen.getByText("Remark");
  const remarkGroup = remarkLabel.closest(".form-group");
  if (!remarkGroup) throw new Error("remark field group not found");
  const remarkInput = remarkGroup.querySelector("textarea");
  if (!remarkInput) throw new Error("remark input not found");
  fireEvent.change(remarkInput, { target: { value: "a remark" } });
}

describe("EntityInstanceCreate — Mandate/Other tabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows required custom fields (title) on the Mandate tab and optional ones only on Other", async () => {
    mockLoad();
    renderAt();

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
});

describe("EntityInstanceCreate — mandatory assignedTo/dueDate/remark", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("blocks submit and never calls POST /entities when the mandatory system fields are empty", async () => {
    mockLoad();
    renderAt();

    await waitFor(() => {
      expect(screen.getByText("Mandate")).toBeDefined();
    });

    // Fill the required custom field (title) so this test isolates the
    // assignedTo/dueDate/remark guard specifically -- title's own native
    // `required` attribute would otherwise block submission first.
    const titleLabel = screen.getByText("Title");
    const titleGroup = titleLabel.closest(".form-group");
    if (!titleGroup) throw new Error("title field group not found");
    const titleInput = titleGroup.querySelector("input");
    if (!titleInput) throw new Error("title input not found");
    fireEvent.change(titleInput, { target: { value: "Some ticket" } });

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

  it("submits assignedTo/dueDate/remark/severity once filled", async () => {
    mockLoad();
    renderAt();

    await waitFor(() => {
      expect(screen.getByText("Mandate")).toBeDefined();
    });

    fetchWithAuth.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.endsWith("/entity-types/et-1"))
        return Promise.resolve({
          data: { id: "et-1", name: "ticket", plural: "Tickets" },
        });
      if (url.includes("/fields"))
        return Promise.resolve({ data: [MANDATE_FIELD, OTHER_FIELD] });
      if (url.includes("/workflows")) return Promise.resolve({ data: [] });
      if (url.includes("/admin/teams"))
        return Promise.resolve({ data: [TEST_TEAM] });
      if (url.includes("/users")) return Promise.resolve({ data: [TEST_USER] });
      if (url === "/api/entities" && opts?.method === "POST") {
        return Promise.resolve({ data: { id: "new-instance-1" } });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    const titleLabel = screen.getByText("Title");
    const titleGroup = titleLabel.closest(".form-group");
    if (!titleGroup) throw new Error("title field group not found");
    const titleInput = titleGroup.querySelector("input");
    if (!titleInput) throw new Error("title input not found");
    fireEvent.change(titleInput, { target: { value: "Some ticket" } });

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
        remark?: string;
        severity?: string;
      };
      expect(body.assignedTo).toBe(TEST_USER.userId);
      expect(body.dueDate).toBeTruthy();
      expect(body.remark).toBe("a remark");
      expect(body.severity).toBe("medium");
    });
  });
});

// docs/specs/team-assign-oncall-fallback.md R2 -- team_id is excluded from
// the generic Other-tab field list even though it's a real optional field.
describe("EntityInstanceCreate — team_id excluded from Other tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("never shows team_id in the Other tab", async () => {
    const TEAM_ID_FIELD = {
      id: "f-team-id",
      name: "team_id",
      label: "Team",
      fieldType: "text",
      isRequired: false,
      isSystem: false,
      config: {},
    };
    mockLoad([MANDATE_FIELD, TEAM_ID_FIELD]);
    renderAt();

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
describe("EntityInstanceCreate — User/Team assign-mode toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("defaults to User mode, showing the UserPicker", async () => {
    mockLoad();
    renderAt();

    await waitFor(() => {
      expect(screen.getByText("Assign to…")).toBeDefined();
    });
  });

  it("switches to Team mode, showing the team select instead of the user picker", async () => {
    mockLoad();
    renderAt();

    await waitFor(() => {
      expect(screen.getByText("Assign to…")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Team"));

    await waitFor(() => {
      expect(screen.getByText("Select a team…")).toBeDefined();
    });
    expect(screen.queryByText("Assign to…")).toBeNull();
  });

  it("blocks submit with a team-specific error when Team mode has no team selected", async () => {
    mockLoad();
    renderAt();

    await waitFor(() => {
      expect(screen.getByText("Mandate")).toBeDefined();
    });

    const titleLabel = screen.getByText("Title");
    const titleGroup = titleLabel.closest(".form-group");
    if (!titleGroup) throw new Error("title field group not found");
    const titleInput = titleGroup.querySelector("input");
    if (!titleInput) throw new Error("title input not found");
    fireEvent.change(titleInput, { target: { value: "Some ticket" } });

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
    mockLoad();
    renderAt();

    await waitFor(() => {
      expect(screen.getByText("Mandate")).toBeDefined();
    });

    fetchWithAuth.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.endsWith("/entity-types/et-1"))
        return Promise.resolve({
          data: { id: "et-1", name: "ticket", plural: "Tickets" },
        });
      if (url.includes("/fields"))
        return Promise.resolve({ data: [MANDATE_FIELD, OTHER_FIELD] });
      if (url.includes("/workflows")) return Promise.resolve({ data: [] });
      if (url.includes("/admin/teams"))
        return Promise.resolve({ data: [TEST_TEAM] });
      if (url.includes("/users")) return Promise.resolve({ data: [TEST_USER] });
      if (url === "/api/entities" && opts?.method === "POST") {
        return Promise.resolve({ data: { id: "new-instance-1" } });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    const titleLabel = screen.getByText("Title");
    const titleGroup = titleLabel.closest(".form-group");
    if (!titleGroup) throw new Error("title field group not found");
    const titleInput = titleGroup.querySelector("input");
    if (!titleInput) throw new Error("title input not found");
    fireEvent.change(titleInput, { target: { value: "Some ticket" } });

    fireEvent.click(screen.getByText("Team"));
    const select = screen.getByText("Select a team…").closest("select");
    if (!select) throw new Error("team select not found");
    fireEvent.change(select, { target: { value: TEST_TEAM.id } });

    const dueDateLabel = screen.getByText("Due Date");
    const dueDateGroup = dueDateLabel.closest(".form-group");
    if (!dueDateGroup) throw new Error("due date field group not found");
    const dueDateInput = dueDateGroup.querySelector("input");
    if (!dueDateInput) throw new Error("due date input not found");
    fireEvent.change(dueDateInput, { target: { value: "2026-01-01T09:00" } });

    const remarkLabel = screen.getByText("Remark");
    const remarkGroup = remarkLabel.closest(".form-group");
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
