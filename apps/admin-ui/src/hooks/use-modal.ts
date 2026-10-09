import { useState, useCallback, useRef } from "react";

export type ModalMode = "create" | "edit";

export interface UseModalOptions<TItem> {
  readonly initialOpen?: boolean;
  readonly initialItem?: TItem | null;
  readonly onOpen?: (item?: TItem) => void;
  readonly onClose?: () => void;
}

export interface UseModalReturn<TItem> {
  readonly isOpen: boolean;
  readonly item: TItem | null;
  readonly mode: ModalMode;
  readonly isEditing: boolean;
  readonly isCreating: boolean;
  readonly open: (item?: TItem) => void;
  readonly openCreate: () => void;
  readonly openEdit: (item: TItem) => void;
  readonly close: () => void;
  readonly toggle: () => void;
}

export function useModal<TItem = void>(
  options?: UseModalOptions<TItem>,
): UseModalReturn<TItem> {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [isOpen, setIsOpen] = useState(options?.initialOpen ?? false);
  const [item, setItem] = useState<TItem | null>(options?.initialItem ?? null);
  const [mode, setMode] = useState<ModalMode>(
    options?.initialItem ? "edit" : "create",
  );

  const open = useCallback((targetItem?: TItem): void => {
    if (targetItem !== undefined && targetItem !== null) {
      setItem(targetItem);
      setMode("edit");
    } else {
      setItem(null);
      setMode("create");
    }
    setIsOpen(true);
    optionsRef.current?.onOpen?.(targetItem);
  }, []);

  const openCreate = useCallback((): void => {
    setItem(null);
    setMode("create");
    setIsOpen(true);
    optionsRef.current?.onOpen?.(undefined);
  }, []);

  const openEdit = useCallback((targetItem: TItem): void => {
    setItem(targetItem);
    setMode("edit");
    setIsOpen(true);
    optionsRef.current?.onOpen?.(targetItem);
  }, []);

  const close = useCallback((): void => {
    setIsOpen(false);
    setItem(null);
    setMode("create");
    optionsRef.current?.onClose?.();
  }, []);

  const toggle = useCallback((): void => {
    setIsOpen((prev) => !prev);
  }, []);

  return {
    isOpen,
    item,
    mode,
    isEditing: isOpen && item !== null,
    isCreating: isOpen && item === null,
    open,
    openCreate,
    openEdit,
    close,
    toggle,
  };
}
