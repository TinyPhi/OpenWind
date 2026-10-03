import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebounce, useDebouncedCallback } from "./use-debounce.js";

describe("useDebounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns initial value immediately", () => {
    const { result } = renderHook(() => useDebounce("initial", 300));
    expect(result.current).toBe("initial");
  });

  it("updates value only after delay elapsed", () => {
    const { result, rerender } = renderHook(
      ({ val, delay }: { val: string; delay: number }) =>
        useDebounce(val, delay),
      { initialProps: { val: "first", delay: 300 } },
    );

    expect(result.current).toBe("first");

    rerender({ val: "second", delay: 300 });
    expect(result.current).toBe("first");

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe("first");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("second");
  });

  it("resets timer when value changes before delay elapsed", () => {
    const { result, rerender } = renderHook(
      ({ val }: { val: string }) => useDebounce(val, 300),
      { initialProps: { val: "first" } },
    );

    rerender({ val: "second" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe("first");

    rerender({ val: "third" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe("first");

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe("third");
  });
});

describe("useDebouncedCallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls callback with arguments after delay", () => {
    const cb = vi.fn();
    const { result } = renderHook(() =>
      useDebouncedCallback<[string, number]>(cb, 200),
    );

    act(() => {
      result.current("hello", 42);
    });

    expect(cb).not.toHaveBeenCalled();
    expect(result.current.isPending()).toBe(true);

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("hello", 42);
    expect(result.current.isPending()).toBe(false);
  });

  it("cancels pending execution when cancel is called", () => {
    const cb = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(cb, 200));

    act(() => {
      result.current("data");
    });
    expect(result.current.isPending()).toBe(true);

    act(() => {
      result.current.cancel();
    });
    expect(result.current.isPending()).toBe(false);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(cb).not.toHaveBeenCalled();
  });

  it("immediately executes pending callback when flush is called", () => {
    const cb = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(cb, 200));

    act(() => {
      result.current("urgent");
    });
    expect(cb).not.toHaveBeenCalled();

    act(() => {
      result.current.flush();
    });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("urgent");
    expect(result.current.isPending()).toBe(false);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("cleans up timer on unmount", () => {
    const cb = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedCallback(cb, 200));

    act(() => {
      result.current("ignored");
    });

    unmount();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(cb).not.toHaveBeenCalled();
  });
});
