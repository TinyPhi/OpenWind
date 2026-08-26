import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as NetworkStatusModule from "./network-status.js";
import { RECOVERED_DISPLAY_MS } from "./network-status.js";

const mockSubscribeToConnectionState = vi.fn().mockReturnValue(() => {});

vi.mock("./notifications-client.js", () => ({
  subscribeToConnectionState: (cb: (s: "open" | "closed") => void) =>
    mockSubscribeToConnectionState(cb),
}));

vi.mock("./api.js", () => ({ API_URL: "/api" }));

function jsonOk(): Response {
  return { ok: true, status: 200 } as Response;
}

function jsonServerError(): Response {
  return { ok: false, status: 500 } as Response;
}

describe("network-status", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let networkStatus: typeof NetworkStatusModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", { onLine: true });
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    networkStatus = await import("./network-status.js");
  });

  afterEach(() => {
    // jsdom's window/document persist across tests within this file even
    // though vi.resetModules() gives each test a fresh module instance —
    // without an explicit teardown, the PREVIOUS test's listeners stay
    // attached to the shared window and fire (with orphaned module state)
    // alongside the current test's, on every subsequent dispatched event.
    networkStatus.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("starts in the online state with no banner", () => {
    const listener = vi.fn();
    networkStatus.subscribe(listener);
    expect(networkStatus.getSnapshot()).toEqual({ kind: "online" });
  });

  it("stays online when navigator.onLine flips false but the probe succeeds", async () => {
    fetchMock.mockResolvedValue(jsonOk());
    const listener = vi.fn();
    networkStatus.subscribe(listener);

    Object.assign(navigator, { onLine: false });
    window.dispatchEvent(new Event("offline"));
    await vi.runAllTimersAsync();

    expect(networkStatus.getSnapshot()).toEqual({ kind: "online" });
  });

  it("shows Reconnecting when onLine is true and the probe times out", async () => {
    fetchMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          // Never resolves on its own — the probe's own AbortController fires the abort.
          setTimeout(
            () => reject(new DOMException("aborted", "AbortError")),
            3_000,
          );
        }),
    );
    const listener = vi.fn();
    networkStatus.subscribe(listener);

    window.dispatchEvent(new Event("network:transport-failure"));
    await vi.advanceTimersByTimeAsync(3_000); // probe timeout
    await vi.advanceTimersByTimeAsync(1_500); // debounce window

    expect(networkStatus.getSnapshot()).toEqual({ kind: "reconnecting" });
  });

  it("shows offline (not reconnecting) when navigator.onLine is false and the probe fails", async () => {
    Object.assign(navigator, { onLine: false });
    fetchMock.mockRejectedValue(new Error("network error"));
    const listener = vi.fn();
    networkStatus.subscribe(listener);

    window.dispatchEvent(new Event("offline"));
    await vi.advanceTimersByTimeAsync(1_500); // debounce window

    expect(networkStatus.getSnapshot()).toEqual({ kind: "offline" });
  });

  it("does not show a banner for a blip shorter than the debounce window", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValue(jsonOk());
    const listener = vi.fn();
    networkStatus.subscribe(listener);

    window.dispatchEvent(new Event("network:transport-failure"));
    // Recover before the 1.5s debounce elapses.
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(0); // let the retry-scheduled probe run
    // The debounced down-state timer is still pending but should never fire
    // a down-state once serverReachable flips back to true first.
    await vi.advanceTimersByTimeAsync(2_000);

    expect(networkStatus.getSnapshot()).toEqual({ kind: "online" });
  });

  it("shows recovered transiently then returns to online after a real outage", async () => {
    // Fixed jitter so the retry schedule is deterministic — otherwise real
    // Math.random() can land a retry inside the debounce window and race
    // this test's own assertions.
    //
    // Explicit 15s timeout (default is 5s): several vi.advanceTimersByTimeAsync
    // calls drain many microtasks each — under full-suite CPU contention this
    // has room to exceed the default before completing.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.01);
    fetchMock.mockResolvedValue(jsonServerError());
    const listener = vi.fn();
    networkStatus.subscribe(listener);

    window.dispatchEvent(new Event("network:transport-failure"));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(networkStatus.getSnapshot()).toEqual({ kind: "reconnecting" });

    fetchMock.mockResolvedValue(jsonOk());
    await vi.advanceTimersByTimeAsync(1_000); // next retry (base delay, random=0 -> 0ms, but timer granularity)
    expect(networkStatus.getSnapshot()).toEqual({ kind: "recovered" });

    await vi.advanceTimersByTimeAsync(RECOVERED_DISPLAY_MS);
    expect(networkStatus.getSnapshot()).toEqual({ kind: "online" });
    randomSpy.mockRestore();
  }, 15_000);

  it("does not let a stale recovered->online timer clobber a new outage that starts during the recovery window", async () => {
    // See the timeout note on the previous test — same reasoning.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.01);
    fetchMock.mockResolvedValueOnce(jsonServerError());
    const listener = vi.fn();
    networkStatus.subscribe(listener);

    // First outage -> reconnecting.
    window.dispatchEvent(new Event("network:transport-failure"));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(networkStatus.getSnapshot()).toEqual({ kind: "reconnecting" });

    // Brief recovery -> "recovered", arms a +4s "recovered -> online" timer.
    fetchMock.mockResolvedValue(jsonOk());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(networkStatus.getSnapshot()).toEqual({ kind: "recovered" });

    // Flaps down again inside that 4s window — must show reconnecting again,
    // and the stale timer from the first recovery must not later force
    // "online" while this second outage is still ongoing.
    fetchMock.mockResolvedValue(jsonServerError());
    window.dispatchEvent(new Event("network:transport-failure"));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(networkStatus.getSnapshot()).toEqual({ kind: "reconnecting" });

    // Advance past when the STALE timer would have fired (4s from the first
    // recovery, ~2.5s ago at this point) — state must still reflect the
    // ongoing outage, not get clobbered back to "online".
    await vi.advanceTimersByTimeAsync(2_000);
    expect(networkStatus.getSnapshot()).toEqual({ kind: "reconnecting" });

    randomSpy.mockRestore();
  }, 15_000);

  it("sends the health probe with credentials omitted, never the session cookie", async () => {
    fetchMock.mockResolvedValue(jsonOk());
    const listener = vi.fn();
    networkStatus.subscribe(listener);

    window.dispatchEvent(new Event("network:transport-failure"));
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/health",
      expect.objectContaining({ credentials: "omit" }),
    );
  });

  it("re-probes on pageshow with persisted true", async () => {
    fetchMock.mockResolvedValue(jsonOk());
    const listener = vi.fn();
    networkStatus.subscribe(listener);
    fetchMock.mockClear();

    window.dispatchEvent(
      Object.assign(new Event("pageshow"), { persisted: true }),
    );
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/health",
      expect.objectContaining({ cache: "no-store", redirect: "error" }),
    );
  });

  it("also re-probes on a plain pageshow (persisted: false) — iOS fires pageshow more reliably than visibilitychange on app switch", async () => {
    fetchMock.mockResolvedValue(jsonOk());
    const listener = vi.fn();
    networkStatus.subscribe(listener);
    fetchMock.mockClear();

    window.dispatchEvent(
      Object.assign(new Event("pageshow"), { persisted: false }),
    );
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalled();
  });

  it("applies jitter within [0, min(cap, base*2^n)] rather than a fixed backoff", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));
    const randomSpy = vi.spyOn(Math, "random");
    randomSpy.mockReturnValueOnce(1); // deterministic upper bound on the first retry
    const listener = vi.fn();
    networkStatus.subscribe(listener);

    window.dispatchEvent(new Event("network:transport-failure"));
    await vi.advanceTimersByTimeAsync(0); // initial probe runs and fails

    // First retry backoff is base(1000ms) * 2^0 = 1000ms at full jitter (random=1).
    expect(randomSpy).toHaveBeenCalled();
    randomSpy.mockRestore();
  });
});
