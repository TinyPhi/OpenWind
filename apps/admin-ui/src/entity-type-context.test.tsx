import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

const mockFetchWithAuth = vi.fn(
  (..._args: unknown[]): Promise<unknown> => Promise.resolve(null),
);
vi.mock("./lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

const { EntityTypeProvider, useEntityTypes } =
  await import("./entity-type-context.js");

function Probe(): React.ReactElement {
  const { entityTypes } = useEntityTypes();
  return <div data-testid="count">{entityTypes.length}</div>;
}

describe("EntityTypeProvider", () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("pages through every cursor instead of truncating to page 1", async () => {
    // A tenant with 120 entity types (e.g. leftover e2e-test fixtures) --
    // page 1 (100) has a cursor, page 2 (20) does not.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `et-${i}`,
      name: `type-${i}`,
      plural: `type-${i}s`,
      icon: null,
      moduleId: null,
    }));
    const page2 = Array.from({ length: 20 }, (_, i) => ({
      id: `et-${100 + i}`,
      name: `type-${100 + i}`,
      plural: `type-${100 + i}s`,
      icon: null,
      moduleId: null,
    }));

    mockFetchWithAuth.mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.includes("/modules")) return Promise.resolve({ data: [] });
      if (u.includes("cursor=")) {
        return Promise.resolve({ data: page2, nextCursor: null });
      }
      return Promise.resolve({ data: page1, nextCursor: "cursor-1" });
    });

    render(
      <EntityTypeProvider>
        <Probe />
      </EntityTypeProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("120"),
    );
  });

  it("resolves a single-page tenant with no extra requests", async () => {
    mockFetchWithAuth.mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.includes("/modules")) return Promise.resolve({ data: [] });
      return Promise.resolve({
        data: [
          {
            id: "et-1",
            name: "ticket",
            plural: "Tickets",
            icon: null,
            moduleId: null,
          },
        ],
        nextCursor: null,
      });
    });

    render(
      <EntityTypeProvider>
        <Probe />
      </EntityTypeProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("1"),
    );
  });
});
