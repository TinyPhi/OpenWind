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

  it("resets state when reset is called", async () => {
    const fn = vi.fn().mockResolvedValue("hello");
    const { result } = renderHook(() => useAsyncAction(fn));

    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.data).toBe("hello");

    act(() => {
      result.current.reset();
    });

    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
