import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./App.js", () => ({ App: (): null => null }));
vi.mock("./lib/theme.js", () => ({ initTheme: vi.fn() }));

describe("vite:preloadError handler in main.tsx", () => {
  const originalLocation = window.location;
  let reloadMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    sessionStorage.clear();
    reloadMock = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: reloadMock },
    });

    let root = document.getElementById("root");
    if (!root) {
      root = document.createElement("div");
      root.id = "root";
      document.body.appendChild(root);
    }

    // Dynamically import main to attach the window listener
    await import("./main.js");
  });

  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("reloads the page and records timestamp on first preload error", () => {
    const event = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(reloadMock).toHaveBeenCalledTimes(1);

    const storedTimestamp = sessionStorage.getItem("ow:chunk-reload-at");
    expect(storedTimestamp).not.toBeNull();
    expect(Number(storedTimestamp)).toBeGreaterThan(0);
  });

  it("prevents infinite reload loops when a second error occurs within 10 seconds", () => {
    // First error triggers reload
    const firstEvent = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(firstEvent);
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(firstEvent.defaultPrevented).toBe(true);

    reloadMock.mockClear();

    // Second error fires within 10 seconds
    const secondEvent = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(secondEvent);

    // Guard prevents another reload
    expect(reloadMock).not.toHaveBeenCalled();
    expect(secondEvent.defaultPrevented).toBe(false);
  });

  it("allows reload recovery after 10-second guard period has passed", () => {
    const elevenSecondsAgo = Date.now() - 11_000;
    sessionStorage.setItem("ow:chunk-reload-at", String(elevenSecondsAgo));

    const event = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(
      Number(sessionStorage.getItem("ow:chunk-reload-at")),
    ).toBeGreaterThan(elevenSecondsAgo);
  });

  it("fails safe without throwing if sessionStorage is unavailable or throws", () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "sessionStorage",
    );
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get: (): never => {
        throw new Error("SecurityError: Access is denied");
      },
    });

    try {
      const event = new Event("vite:preloadError", { cancelable: true });
      expect(() => window.dispatchEvent(event)).not.toThrow();
      expect(reloadMock).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(window, "sessionStorage", originalDescriptor);
      }
    }
  });
});
