import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import React from "react";

const mockFetchWithAuth = vi.fn(
  (..._args: unknown[]): Promise<unknown> => Promise.resolve(null),
);
vi.mock("../../lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

const { CreateApiKeyModal } = await import("./create.js");

const mockOnClose = vi.fn();
const mockOnCreated = vi.fn();

function renderModal(): ReturnType<typeof render> {
  return render(
    React.createElement(CreateApiKeyModal, {
      open: true,
      onClose: mockOnClose,
      onCreated: mockOnCreated,
    }),
  );
}

describe("CreateApiKeyModal (ADR-012 Phase A spec R7/R8, PR A5)", () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
    mockOnClose.mockReset();
    mockOnCreated.mockReset();
  });
  afterEach(() => cleanup());

  it("disables Create Key until the required application fields are filled", () => {
    renderModal();
    const submit = screen.getByRole("button", { name: /create key/i });
    expect(submit).toHaveProperty("disabled", true);
  });

  it("defaults to the Read-only preset", async () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/acme helpdesk sync/i), {
      target: { value: "Acme Helpdesk Sync" },
    });
    fireEvent.change(screen.getByPlaceholderText(/ops@example.com/i), {
      target: { value: "ops@acme.example" },
    });
    fireEvent.change(
      screen.getByPlaceholderText(/acme-helpdesk-sync-client/i),
      {
        target: { value: "acme-client" },
      },
    );

    mockFetchWithAuth.mockResolvedValueOnce({
      data: { key: "sk_live_abc123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create key$/i }));

    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());
    const [, options] = mockFetchWithAuth.mock.calls[0] as [
      string,
      { body: string },
    ];
    const body = JSON.parse(options.body) as { scopes: string[] };
    expect(body.scopes).toEqual(["entity:ticket:read"]);
  });

  it("switches to the Read-write preset's full verb set on click", async () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/acme helpdesk sync/i), {
      target: { value: "Acme Helpdesk Sync" },
    });
    fireEvent.change(screen.getByPlaceholderText(/ops@example.com/i), {
      target: { value: "ops@acme.example" },
    });
    fireEvent.change(
      screen.getByPlaceholderText(/acme-helpdesk-sync-client/i),
      {
        target: { value: "acme-client" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: /^read-write$/i }));

    mockFetchWithAuth.mockResolvedValueOnce({
      data: { key: "sk_live_abc123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create key$/i }));

    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());
    const [, options] = mockFetchWithAuth.mock.calls[0] as [
      string,
      { body: string },
    ];
    const body = JSON.parse(options.body) as { scopes: string[] };
    expect(body.scopes).toHaveLength(6);
    expect(body.scopes).toContain("entity:ticket:transition");
  });

  it("Custom mode requires at least one checked scope before Create Key is enabled", () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/acme helpdesk sync/i), {
      target: { value: "Acme Helpdesk Sync" },
    });
    fireEvent.change(screen.getByPlaceholderText(/ops@example.com/i), {
      target: { value: "ops@acme.example" },
    });
    fireEvent.change(
      screen.getByPlaceholderText(/acme-helpdesk-sync-client/i),
      {
        target: { value: "acme-client" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: /^custom$/i }));

    expect(
      screen.getByRole("button", { name: /^create key$/i }),
    ).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByLabelText("entity:ticket:read"));
    expect(
      screen.getByRole("button", { name: /^create key$/i }),
    ).toHaveProperty("disabled", false);
  });

  it("shows the raw key exactly once after successful creation", async () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/acme helpdesk sync/i), {
      target: { value: "Acme Helpdesk Sync" },
    });
    fireEvent.change(screen.getByPlaceholderText(/ops@example.com/i), {
      target: { value: "ops@acme.example" },
    });
    fireEvent.change(
      screen.getByPlaceholderText(/acme-helpdesk-sync-client/i),
      {
        target: { value: "acme-client" },
      },
    );
    mockFetchWithAuth.mockResolvedValueOnce({
      data: { key: "sk_live_shown_once" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create key$/i }));

    await screen.findByText("sk_live_shown_once");
  });

  it("calls onCreated (not onClose) after Done is clicked post-creation", async () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/acme helpdesk sync/i), {
      target: { value: "Acme Helpdesk Sync" },
    });
    fireEvent.change(screen.getByPlaceholderText(/ops@example.com/i), {
      target: { value: "ops@acme.example" },
    });
    fireEvent.change(
      screen.getByPlaceholderText(/acme-helpdesk-sync-client/i),
      {
        target: { value: "acme-client" },
      },
    );
    mockFetchWithAuth.mockResolvedValueOnce({
      data: { key: "sk_live_shown_once" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create key$/i }));
    await screen.findByText("sk_live_shown_once");

    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    expect(mockOnCreated).toHaveBeenCalledOnce();
    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it("shows the API error message when creation fails", async () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/acme helpdesk sync/i), {
      target: { value: "Acme Helpdesk Sync" },
    });
    fireEvent.change(screen.getByPlaceholderText(/ops@example.com/i), {
      target: { value: "ops@acme.example" },
    });
    fireEvent.change(
      screen.getByPlaceholderText(/acme-helpdesk-sync-client/i),
      {
        target: { value: "acme-client" },
      },
    );
    mockFetchWithAuth.mockRejectedValueOnce(
      new Error("This OIDC Client ID is already registered"),
    );
    fireEvent.click(screen.getByRole("button", { name: /^create key$/i }));

    await screen.findByText(/already registered/i);
  });
});
