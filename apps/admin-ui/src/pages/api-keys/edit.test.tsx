import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import React from "react";
import type { ApiKeyRow } from "./status.js";

const mockFetchWithAuth = vi.fn(
  (..._args: unknown[]): Promise<unknown> => Promise.resolve(null),
);
vi.mock("../../lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

const { EditApiKeyModal } = await import("./edit.js");

const mockOnClose = vi.fn();
const mockOnSaved = vi.fn();

const KEY: ApiKeyRow = {
  id: "key-1",
  name: "acme-key",
  scopes: ["entity:ticket:read"],
  scopesFormat: "action",
  applicationName: "Acme Helpdesk Sync",
  applicationDescription: "Original description",
  applicationContactEmail: "original@example.com",
  rotatedFrom: null,
  createdAt: "2026-01-01T00:00:00Z",
  createdBy: "admin-1",
  expiresAt: "2027-01-01T00:00:00Z",
  revokedAt: null,
};

function renderModal(
  keyRow: ApiKeyRow | null = KEY,
): ReturnType<typeof render> {
  return render(
    React.createElement(EditApiKeyModal, {
      keyRow,
      onClose: mockOnClose,
      onSaved: mockOnSaved,
    }),
  );
}

describe("EditApiKeyModal (ADR-012 Phase A PR A5, AC7)", () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
    mockOnClose.mockReset();
    mockOnSaved.mockReset();
  });
  afterEach(() => cleanup());

  it("pre-fills the description and contact email from the passed key", () => {
    renderModal();
    expect(screen.getByDisplayValue("Original description")).toBeTruthy();
    expect(screen.getByDisplayValue("original@example.com")).toBeTruthy();
  });

  it("does not render when keyRow is null", () => {
    renderModal(null);
    expect(screen.queryByText(/^edit/i)).toBeNull();
  });

  it("saves via PATCH /api-keys/:id with only description and contact email", async () => {
    renderModal();
    fireEvent.change(
      screen.getByPlaceholderText(/what this integration does/i),
      {
        target: { value: "New description" },
      },
    );
    fireEvent.change(screen.getByPlaceholderText(/ops@example.com/i), {
      target: { value: "new@example.com" },
    });
    mockFetchWithAuth.mockResolvedValueOnce({ data: {} });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());
    const [url, options] = mockFetchWithAuth.mock.calls[0] as [
      string,
      { method: string; body: string },
    ];
    expect(url).toBe("/api/api-keys/key-1");
    expect(options.method).toBe("PATCH");
    const body = JSON.parse(options.body) as Record<string, unknown>;
    expect(body).toEqual({
      applicationDescription: "New description",
      applicationContactEmail: "new@example.com",
    });
  });

  it("calls onSaved after a successful save", async () => {
    renderModal();
    mockFetchWithAuth.mockResolvedValueOnce({ data: {} });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(mockOnSaved).toHaveBeenCalledOnce());
    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it("disables Save Changes when contact email is cleared", () => {
    renderModal();
    fireEvent.change(screen.getByPlaceholderText(/ops@example.com/i), {
      target: { value: "" },
    });
    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toHaveProperty("disabled", true);
  });

  it("shows the API error message when saving fails", async () => {
    renderModal();
    mockFetchWithAuth.mockRejectedValueOnce(new Error("Something went wrong"));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await screen.findByText(/something went wrong/i);
  });
});
