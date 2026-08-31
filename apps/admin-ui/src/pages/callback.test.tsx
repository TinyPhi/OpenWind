import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type * as ReactRouterDom from "react-router-dom";
import "../i18n.js";

const navigateSpy = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof ReactRouterDom>("react-router-dom");
  return { ...actual, useNavigate: () => navigateSpy };
});

const signinCallback = vi.fn();
vi.mock("../authProvider.js", () => ({
  userManager: { signinCallback },
}));

const fetchWithAuth = vi.fn();
vi.mock("../lib/api.js", () => ({
  fetchWithAuth: (...args: unknown[]): unknown => fetchWithAuth(...args),
  API_URL: "/api",
}));

const { AuthCallback } = await import("./callback.js");

function renderCallback(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/auth/callback"]}>
      <AuthCallback />
    </MemoryRouter>,
  );
}

describe("AuthCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // Hosted ticket-create handoff (docs/specs/hosted-ticket-create-handoff.md,
  // spec R2 + T6) -- unrelated logins (no handoff state) must be unaffected.
  it("with no handoff state, navigates to /dashboard as before", async () => {
    signinCallback.mockResolvedValue({ state: undefined });
    renderCallback();

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith("/dashboard");
    });
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it("with no user resolved, navigates back to /login", async () => {
    signinCallback.mockResolvedValue(null);
    renderCallback();

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith("/login");
    });
  });

  const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
  const ENTITY_TYPE_ID = "22222222-2222-4222-8222-222222222222";

  it("with valid handoff state, resolves the entity type and navigates to the pre-filled create page (spec R1)", async () => {
    signinCallback.mockResolvedValue({
      state: {
        workflowId: WORKFLOW_ID,
        entityTypeId: ENTITY_TYPE_ID,
        prefillFields: { title: "Client dinner" },
      },
    });
    fetchWithAuth.mockResolvedValue({
      data: { id: ENTITY_TYPE_ID, name: "Expense", plural: "Expenses" },
    });
    renderCallback();

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith("/records/expenses/new", {
        state: {
          workflowId: WORKFLOW_ID,
          entityTypeId: ENTITY_TYPE_ID,
          prefillFields: { title: "Client dinner" },
        },
      });
    });
    expect(fetchWithAuth).toHaveBeenCalledWith(
      `/api/entity-types/${ENTITY_TYPE_ID}`,
    );
  });

  // spec R5 -- a well-formed but nonexistent entityTypeId must degrade
  // gracefully (the backend 404s / fetchWithAuth rejects), not crash.
  it("with a handoff entityTypeId that fails to resolve, falls back to /dashboard instead of crashing", async () => {
    signinCallback.mockResolvedValue({
      state: { workflowId: WORKFLOW_ID, entityTypeId: ENTITY_TYPE_ID },
    });
    fetchWithAuth.mockRejectedValue(new Error("404"));
    renderCallback();

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith("/dashboard");
    });
    expect(screen.queryByText(/error/i)).toBeNull();
  });

  // spec R5 -- malformed (non-object / missing fields) state also degrades gracefully.
  it("with malformed handoff state (missing entityTypeId), falls back to /dashboard without calling fetchWithAuth", async () => {
    signinCallback.mockResolvedValue({
      state: { workflowId: WORKFLOW_ID },
    });
    renderCallback();

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith("/dashboard");
    });
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  // PrabhuVijit's PR #542 review: isHandoffState's original typeof-only
  // check let a non-UUID (e.g. a path-traversal payload) reach the
  // fetchWithAuth URL path before anything rejected it. Now rejected at
  // the guard itself, before any fetch is attempted.
  it("rejects a non-UUID entityTypeId at the guard, without ever calling fetchWithAuth", async () => {
    signinCallback.mockResolvedValue({
      state: { workflowId: WORKFLOW_ID, entityTypeId: "../../api/entities" },
    });
    renderCallback();

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith("/dashboard");
    });
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID workflowId at the guard, without ever calling fetchWithAuth", async () => {
    signinCallback.mockResolvedValue({
      state: { workflowId: "not-a-uuid", entityTypeId: ENTITY_TYPE_ID },
    });
    renderCallback();

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith("/dashboard");
    });
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});
