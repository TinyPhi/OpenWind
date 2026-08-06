import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";

vi.mock("../lib/api.js", () => ({ fetchWithAuth: vi.fn(), API_URL: "" }));

const api = await import("../lib/api.js");
const fetchWithAuth = vi.mocked(api.fetchWithAuth);
const { UserRefPicker } = await import("./user-ref-picker.js");

beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithAuth.mockResolvedValue({
    data: [
      { userId: "u1", email: "alice@example.com", displayName: "Alice" },
      { userId: "u2", email: "bob@example.com", displayName: null },
    ],
  });
});

afterEach(() => cleanup());

describe("UserRefPicker", () => {
  it("fetches /users and shows the selected user's display name", async () => {
    render(<UserRefPicker value="u1" onChange={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("Alice")).not.toBeNull();
    });
  });

  it("falls back to email when displayName is null", async () => {
    render(<UserRefPicker value="u2" onChange={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("bob@example.com")).not.toBeNull();
    });
  });

  it("calls onChange with the picked user's id", async () => {
    const onChange = vi.fn();
    render(<UserRefPicker value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => screen.getByText("Alice"));
    fireEvent.click(screen.getByText("Alice"));
    expect(onChange).toHaveBeenCalledWith("u1");
  });
});
