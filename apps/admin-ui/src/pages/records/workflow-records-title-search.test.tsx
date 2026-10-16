import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  waitFor,
  cleanup,
  fireEvent,
  screen,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// docs/specs/mandatory-ticket-fields.md R2. isSystem means protected, not hidden. The records
// list used to drop system fields, so for helpdesk tickets (whose title is a system field)
// it never found the title field and "Search by title" matched nothing.

const mockFetchWithAuth = vi.fn(
  (_url: string): Promise<unknown> => Promise.resolve({ data: undefined }),
);
vi.mock("../../lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (url: string) => mockFetchWithAuth(url),
}));

vi.mock("../../authProvider.js", () => ({
  userManager: {
    getUser: () =>
      Promise.resolve({
        profile: {
          sub: "admin-1",
          "urn:zitadel:iam:org:project:roles": { admin: {} },
        },
      } as unknown),
  },
}));

const { WorkflowRecords } = await import("./workflow-records.js");

const WORKFLOW_ID = "wf-1";
const ENTITY_TYPE_ID = "et-1";

function ticket(id: string, title: string): Record<string, unknown> {
  return {
    id,
    currentState: null,
    fields: { title },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    origin: null,
  };
}

function mockRoutes(): void {
  mockFetchWithAuth.mockImplementation((url: string) => {
    if (url.endsWith("/workflows/slugs")) {
      return Promise.resolve({ data: [{ id: WORKFLOW_ID, name: "Support" }] });
    }
    if (url.endsWith(`/workflows/${WORKFLOW_ID}`)) {
      return Promise.resolve({
        data: {
          id: WORKFLOW_ID,
          name: "Support",
          entityTypeId: ENTITY_TYPE_ID,
          createdBy: "admin-1",
          assignedTo: [],
          states: [],
          transitions: [],
        },
      });
    }
    if (url.includes(`/entity-types/${ENTITY_TYPE_ID}/fields`)) {
      return Promise.resolve({
        data: [
          {
            id: "f-title",
            name: "title",
            label: "Title",
            fieldType: "text",
            isRequired: true,
            isSystem: true,
            config: {},
          },
        ],
      });
    }
    if (url.includes(`/entities?entityTypeId=${ENTITY_TYPE_ID}`)) {
      return Promise.resolve({
        data: [
          ticket("t-1", "Printer offline"),
          ticket("t-2", "VPN keeps dropping"),
        ],
      });
    }
    return Promise.resolve({ data: [] });
  });
}

async function waitForCardCount(
  container: HTMLElement,
  expected: number,
): Promise<void> {
  await waitFor(
    () => {
      expect(container.querySelectorAll(".kb-card")).toHaveLength(expected);
    },
    { timeout: 5_000 },
  );
}

describe("WorkflowRecords — title search with a system title field", () => {
  afterEach(() => {
    cleanup();
    mockFetchWithAuth.mockReset();
  });

  it("filters cards by the title even when title is a system field", async () => {
    mockRoutes();
    const { container } = render(
      <MemoryRouter initialEntries={["/workflows/support/records"]}>
        <Routes>
          <Route
            path="/workflows/:workflowSlug/records"
            element={<WorkflowRecords />}
          />
        </Routes>
      </MemoryRouter>,
    );
    await waitForCardCount(container, 2);

    fireEvent.click(screen.getByTitle("Search"));
    fireEvent.change(screen.getByPlaceholderText("Search by title…"), {
      target: { value: "printer" },
    });

    await waitForCardCount(container, 1);
    expect(container.textContent).toContain("Printer offline");
  });
});
