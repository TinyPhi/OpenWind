import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api.js", () => ({
  API_URL: "",
  fetchWithAuth: vi.fn(),
}));

vi.mock("../authProvider.js", () => ({
  userManager: {
    getUser: vi.fn().mockResolvedValue({ profile: {} }),
  },
}));

const api = await import("../lib/api.js");
const fetchWithAuth = vi.mocked(api.fetchWithAuth);
const { UsersPage } = await import("./users.js");

beforeEach(() => {
  fetchWithAuth.mockReset();
});

afterEach(() => cleanup());

describe("UsersPage", () => {
  it.each(["", "   "])(
    "renders the fallback initial when a user's display name is %j",
    async (displayName) => {
      fetchWithAuth.mockResolvedValue({
        data: [
          {
            userId: "user-1",
            displayName,
            email: "user@example.com",
            loginName: "user",
            roles: [],
          },
        ],
      });

      render(<UsersPage />);

      await waitFor(() => expect(screen.getByText("U")).not.toBeNull());
    },
  );
});
