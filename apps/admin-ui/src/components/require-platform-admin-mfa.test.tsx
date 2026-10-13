import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

interface FakeResponse {
  ok: boolean;
  json: () => Promise<Record<string, unknown>>;
}

const mockFetchRawWithAuth = vi.fn(
  (): Promise<FakeResponse> =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
);
vi.mock("../lib/api.js", () => ({
  fetchRawWithAuth: () => mockFetchRawWithAuth(),
  API_URL: "/api",
}));

function makeResponse(
  ok: boolean,
  body: Record<string, unknown>,
): FakeResponse {
  return { ok, json: () => Promise.resolve(body) };
}

const { RequirePlatformAdminMfa } =
  await import("./require-platform-admin-mfa.js");

function renderGuard(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/platform-admin/dashboard"]}>
      <Routes>
        <Route path="/platform-admin/login" element={<div>Login page</div>} />
        <Route path="/platform-admin/mfa" element={<div>MFA page</div>} />
        <Route element={<RequirePlatformAdminMfa />}>
          <Route
            path="/platform-admin/dashboard"
            element={<div>Dashboard content</div>}
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("RequirePlatformAdminMfa", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the protected content when the session check succeeds", async () => {
    mockFetchRawWithAuth.mockResolvedValue(makeResponse(true, { data: {} }));
    renderGuard();

    await waitFor(() => {
      expect(screen.getByText("Dashboard content")).toBeTruthy();
    });
  });

  it("redirects to /platform-admin/mfa on a 403 MFA_REQUIRED response", async () => {
    mockFetchRawWithAuth.mockResolvedValue(
      makeResponse(false, { error: "MFA_REQUIRED" }),
    );
    renderGuard();

    await waitFor(() => {
      expect(screen.getByText("MFA page")).toBeTruthy();
    });
  });

  it("redirects to /platform-admin/login on any other failure", async () => {
    mockFetchRawWithAuth.mockResolvedValue(
      makeResponse(false, { error: "FORBIDDEN" }),
    );
    renderGuard();

    await waitFor(() => {
      expect(screen.getByText("Login page")).toBeTruthy();
    });
  });

  it("redirects to /platform-admin/login when the request itself throws", async () => {
    mockFetchRawWithAuth.mockRejectedValue(new Error("network error"));
    renderGuard();

    await waitFor(() => {
      expect(screen.getByText("Login page")).toBeTruthy();
    });
  });
});
