import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAsyncAction } from "./use-async-action.js";

describe("useAsyncAction", () => {
  it("initializes with idle state", () => {
    const fn = vi.fn().mockResolvedValue("done");
    const { result } = renderHook(() => useAsyncAction(fn));

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.data).toBeNull();
  });

  it("handles successful execution", async () => {
    const fn = vi.fn().mockResolvedValue({ id: "123" });
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useAsyncAction(fn, { onSuccess }));

    let res: { id: string } | null = null;
    await act(async () => {
      res = await result.current.execute();
    });

    expect(res).toEqual({ id: "123" });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual({ id: "123" });
    expect(result.current.error).toBeNull();
    expect(onSuccess).toHaveBeenCalledWith({ id: "123" }, undefined);
  });

  it("handles failed execution and extracts error message", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Network failure"));
    const onError = vi.fn();
    const { result } = renderHook(() => useAsyncAction(fn, { onError }));

    let res: unknown = null;
    await act(async () => {
      res = await result.current.execute();
    });

    expect(res).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBe("Network failure");
    expect(onError).toHaveBeenCalledWith(expect.any(Error), undefined);
  });

  it("normalizes non-Error thrown primitives (strings and objects)", async () => {
    const fn = vi.fn().mockRejectedValue("string failure");
    const onError = vi.fn();
    const { result } = renderHook(() => useAsyncAction(fn, { onError }));

    await act(async () => {
      await result.current.execute();
    });

    expect(result.current.error).toBe("string failure");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "string failure" }),
      undefined,
    );
  });

  it("discards stale results when multiple concurrent executions are initiated", async () => {
    let resolveFirst!: (val: string) => void;
    let resolveSecond!: (val: string) => void;

    let callCount = 0;
    const fn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise<string>((res) => {
          resolveFirst = res;
        });
      }
      return new Promise<string>((res) => {
        resolveSecond = res;
      });
    });

    const { result } = renderHook(() => useAsyncAction<string>(fn));

    let p1: Promise<string | null>;
    let p2: Promise<string | null>;
    act(() => {
      p1 = result.current.execute();
      p2 = result.current.execute();
    });

    // Second call resolves first
    await act(async () => {
      resolveSecond("Call 2 result");
      await p2;
    });

    expect(result.current.data).toBe("Call 2 result");
    expect(result.current.isLoading).toBe(false);

    // First call finishes late
    await act(async () => {
      resolveFirst("Call 1 stale result");
      await p1;
    });

    // Stale result did not overwrite Call 2
    expect(result.current.data).toBe("Call 2 result");
    expect(result.current.isLoading).toBe(false);
  });

  it("resets state when reset is called and ignores in-flight executions", async () => {
    let resolveFn!: (val: string) => void;
    const fn = vi.fn().mockImplementation(
      () =>
        new Promise<string>((res) => {
          resolveFn = res;
        }),
    );
    const { result } = renderHook(() => useAsyncAction<string>(fn));

    let p: Promise<string | null>;
    act(() => {
      p = result.current.execute();
    });
    expect(result.current.isLoading).toBe(true);

    act(() => {
      result.current.reset();
    });
    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      resolveFn("late");
      await p;
    });

    // Still clean after reset
    expect(result.current.data).toBeNull();
  });
});
