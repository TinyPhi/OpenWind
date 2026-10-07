import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useOutsideClick } from "./use-outside-click.js";

describe("useOutsideClick", () => {
  let insideElement: HTMLDivElement;
  let outsideElement: HTMLDivElement;

  beforeEach(() => {
    insideElement = document.createElement("div");
    outsideElement = document.createElement("div");
    document.body.appendChild(insideElement);
    document.body.appendChild(outsideElement);
  });

  afterEach(() => {
    cleanup();
    insideElement.remove();
    outsideElement.remove();
    vi.restoreAllMocks();
  });

  it("attaches mousedown listener on mount", () => {
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");
    const onOutside = vi.fn();
    const ref = { current: insideElement };

    renderHook(() => useOutsideClick(ref, onOutside));

    expect(addEventListenerSpy).toHaveBeenCalledWith(
      "mousedown",
      expect.any(Function),
    );
  });

  it("triggers onOutside when clicking outside the referenced element", () => {
    const onOutside = vi.fn();
    const ref = { current: insideElement };

    renderHook(() => useOutsideClick(ref, onOutside));

    const event = new MouseEvent("mousedown", { bubbles: true });
    outsideElement.dispatchEvent(event);

    expect(onOutside).toHaveBeenCalledTimes(1);
  });

  it("does not trigger onOutside when clicking inside the referenced element", () => {
    const onOutside = vi.fn();
    const ref = { current: insideElement };
    const innerChild = document.createElement("span");
    insideElement.appendChild(innerChild);

    renderHook(() => useOutsideClick(ref, onOutside));

    innerChild.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onOutside).not.toHaveBeenCalled();

    insideElement.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onOutside).not.toHaveBeenCalled();
  });

  it("does not trigger onOutside if ref.current is null", () => {
    const onOutside = vi.fn();
    const ref = { current: null };

    renderHook(() => useOutsideClick(ref, onOutside));

    outsideElement.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true }),
    );
    expect(onOutside).not.toHaveBeenCalled();
  });

  it("removes event listener on unmount and ignores subsequent clicks", () => {
    const removeEventListenerSpy = vi.spyOn(document, "removeEventListener");
    const onOutside = vi.fn();
    const ref = { current: insideElement };

    const { unmount } = renderHook(() => useOutsideClick(ref, onOutside));

    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      "mousedown",
      expect.any(Function),
    );

    outsideElement.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true }),
    );
    expect(onOutside).not.toHaveBeenCalled();
  });

  describe("across re-renders with a new inline callback", () => {
    function mousedownCalls(spy: { mock: { calls: unknown[][] } }): number {
      return spy.mock.calls.filter((c) => c[0] === "mousedown").length;
    }

    it("registers the mousedown listener once however often it re-renders", () => {
      const addSpy = vi.spyOn(document, "addEventListener");
      const removeSpy = vi.spyOn(document, "removeEventListener");
      const ref = { current: insideElement };

      const { rerender } = renderHook(() => useOutsideClick(ref, () => {}));
      rerender();
      rerender();
      rerender();

      expect(mousedownCalls(addSpy)).toBe(1);
      expect(mousedownCalls(removeSpy)).toBe(0);
    });

    it("invokes the latest callback after a re-render, not a stale one", () => {
      const first = vi.fn();
      const second = vi.fn();
      const ref = { current: insideElement };

      const { rerender } = renderHook(
        ({ cb }: { cb: () => void }) => useOutsideClick(ref, cb),
        { initialProps: { cb: first } },
      );
      rerender({ cb: second });

      outsideElement.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });

    it("removes the listener exactly once on unmount", () => {
      const removeSpy = vi.spyOn(document, "removeEventListener");
      const ref = { current: insideElement };

      const { rerender, unmount } = renderHook(() =>
        useOutsideClick(ref, () => {}),
      );
      rerender();
      unmount();

      expect(mousedownCalls(removeSpy)).toBe(1);
    });

    it("does not call the latest callback for an inside click after a re-render", () => {
      const latest = vi.fn();
      const ref = { current: insideElement };

      const { rerender } = renderHook(
        ({ cb }: { cb: () => void }) => useOutsideClick(ref, cb),
        { initialProps: { cb: vi.fn() } },
      );
      rerender({ cb: latest });

      insideElement.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );

      expect(latest).not.toHaveBeenCalled();
    });
  });
});
