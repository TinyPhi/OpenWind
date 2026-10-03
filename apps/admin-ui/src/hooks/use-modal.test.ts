import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useModal } from "./use-modal.js";

interface TestItem {
  id: string;
  name: string;
}

describe("useModal", () => {
  it("initializes with default closed state", () => {
    const { result } = renderHook(() => useModal<TestItem>());

    expect(result.current.isOpen).toBe(false);
    expect(result.current.item).toBeNull();
    expect(result.current.mode).toBe("create");
    expect(result.current.isCreating).toBe(false);
    expect(result.current.isEditing).toBe(false);
  });

  it("initializes with initial options if provided", () => {
    const initialItem: TestItem = { id: "1", name: "Alpha" };
    const { result } = renderHook(() =>
      useModal<TestItem>({ initialOpen: true, initialItem }),
    );

    expect(result.current.isOpen).toBe(true);
    expect(result.current.item).toEqual(initialItem);
    expect(result.current.mode).toBe("edit");
    expect(result.current.isEditing).toBe(true);
    expect(result.current.isCreating).toBe(false);
  });

  it("opens in create mode when openCreate is called", () => {
    const onOpen = vi.fn();
    const { result } = renderHook(() => useModal<TestItem>({ onOpen }));

    act(() => {
      result.current.openCreate();
    });

    expect(result.current.isOpen).toBe(true);
    expect(result.current.item).toBeNull();
    expect(result.current.mode).toBe("create");
    expect(result.current.isCreating).toBe(true);
    expect(result.current.isEditing).toBe(false);
    expect(onOpen).toHaveBeenCalledWith(undefined);
  });

  it("opens in edit mode when openEdit is called with an item", () => {
    const onOpen = vi.fn();
    const testItem: TestItem = { id: "42", name: "Bravo" };
    const { result } = renderHook(() => useModal<TestItem>({ onOpen }));

    act(() => {
      result.current.openEdit(testItem);
    });

    expect(result.current.isOpen).toBe(true);
    expect(result.current.item).toEqual(testItem);
    expect(result.current.mode).toBe("edit");
    expect(result.current.isEditing).toBe(true);
    expect(result.current.isCreating).toBe(false);
    expect(onOpen).toHaveBeenCalledWith(testItem);
  });

  it("closes and resets item when close is called", () => {
    const onClose = vi.fn();
    const testItem: TestItem = { id: "42", name: "Bravo" };
    const { result } = renderHook(() => useModal<TestItem>({ onClose }));

    act(() => {
      result.current.openEdit(testItem);
    });
    expect(result.current.isOpen).toBe(true);

    act(() => {
      result.current.close();
    });

    expect(result.current.isOpen).toBe(false);
    expect(result.current.item).toBeNull();
    expect(onClose).toHaveBeenCalled();
  });

  it("toggles open state with toggle", () => {
    const { result } = renderHook(() => useModal<void>());

    expect(result.current.isOpen).toBe(false);

    act(() => {
      result.current.toggle();
    });
    expect(result.current.isOpen).toBe(true);

    act(() => {
      result.current.toggle();
    });
    expect(result.current.isOpen).toBe(false);
  });
});
