import { useEffect, useRef, useState, useCallback, useMemo } from "react";

export interface UseDebouncedCallbackControls {
  readonly cancel: () => void;
  readonly flush: () => void;
  readonly isPending: () => boolean;
}

export type UseDebouncedCallbackReturn<TArgs extends readonly unknown[]> = ((
  ...args: TArgs
) => void) &
  UseDebouncedCallbackControls;

/**
 * Returns a debounced value that only updates after the specified delay has elapsed
 * since the last change to the input value.
 */
export function useDebounce<TValue>(
  value: TValue,
  delayMs: number = 300,
): TValue {
  const [debouncedValue, setDebouncedValue] = useState<TValue>(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debouncedValue;
}

/**
 * Returns a debounced version of the provided callback function with cancel,
 * flush, and isPending controls. Unmount cancels pending executions automatically.
 */
export function useDebouncedCallback<TArgs extends readonly unknown[]>(
  callback: (...args: TArgs) => void,
  delayMs: number = 300,
): UseDebouncedCallbackReturn<TArgs> {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingArgsRef = useRef<TArgs | null>(null);
  const hasPendingRef = useRef(false);

  const cancel = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    hasPendingRef.current = false;
    pendingArgsRef.current = null;
  }, []);

  const flush = useCallback((): void => {
    if (timerRef.current !== null && hasPendingRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      if (pendingArgsRef.current !== null) {
        callbackRef.current(...pendingArgsRef.current);
      }
      hasPendingRef.current = false;
      pendingArgsRef.current = null;
    }
  }, []);

  const isPending = useCallback((): boolean => {
    return timerRef.current !== null;
  }, []);

  const debounced = useCallback(
    (...args: TArgs): void => {
      pendingArgsRef.current = args;
      hasPendingRef.current = true;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        hasPendingRef.current = false;
        pendingArgsRef.current = null;
        callbackRef.current(...args);
      }, delayMs);
    },
    [delayMs],
  );

  useEffect(() => {
    return () => {
      cancel();
    };
  }, [cancel]);

  const controls = useMemo(
    () => ({ cancel, flush, isPending }),
    [cancel, flush, isPending],
  );

  return useMemo(
    () => Object.assign(debounced, controls),
    [debounced, controls],
  );
}
