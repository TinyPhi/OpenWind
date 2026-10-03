import { describe, it, expect, vi } from "vitest";
import { onSessionEnd, emitSessionEnd } from "./session-events.js";

describe("session-events", () => {
  it("invokes registered callbacks when emitSessionEnd is called", () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();

    const unsub1 = onSessionEnd(callback1);
    const unsub2 = onSessionEnd(callback2);

    emitSessionEnd();

    expect(callback1).toHaveBeenCalledTimes(1);
    expect(callback2).toHaveBeenCalledTimes(1);

    unsub1();
    unsub2();
  });

  it("unsubscribes listeners cleanly", () => {
    const callback = vi.fn();
    const unsub = onSessionEnd(callback);

    emitSessionEnd();
    expect(callback).toHaveBeenCalledTimes(1);

    unsub();
    emitSessionEnd();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("isolates errors so a throwing listener does not block other listeners or throw", () => {
    const errorListener = vi.fn().mockImplementation(() => {
      throw new Error("Cache reset failed");
    });
    const normalListener = vi.fn();

    const unsub1 = onSessionEnd(errorListener);
    const unsub2 = onSessionEnd(normalListener);

    expect(() => emitSessionEnd()).not.toThrow();
    expect(errorListener).toHaveBeenCalledTimes(1);
    expect(normalListener).toHaveBeenCalledTimes(1);

    unsub1();
    unsub2();
  });
});
