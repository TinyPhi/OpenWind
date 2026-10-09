import { useState, useCallback, useRef, useEffect } from "react";

export interface UseAsyncActionOptions<TResult, TArgs> {
  readonly onSuccess?: (data: TResult, args: TArgs) => void;
  readonly onError?: (error: Error, args: TArgs) => void;
  readonly errorMessageFallback?: string;
}

export type UseAsyncActionExecute<TResult, TArgs> = [TArgs] extends [void]
  ? (args?: TArgs) => Promise<TResult | null>
  : (args: TArgs) => Promise<TResult | null>;

export interface UseAsyncActionReturn<TResult, TArgs> {
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly data: TResult | null;
  readonly execute: UseAsyncActionExecute<TResult, TArgs>;
  readonly reset: () => void;
  readonly setError: (error: string | null) => void;
}

export function useAsyncAction<TResult, TArgs = void>(
  action: (args: TArgs) => Promise<TResult>,
  options?: UseAsyncActionOptions<TResult, TArgs>,
): UseAsyncActionReturn<TResult, TArgs> {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<TResult | null>(null);

  const actionRef = useRef(action);
  actionRef.current = action;

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const isMountedRef = useRef(true);
  const executionIdRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const reset = useCallback((): void => {
    executionIdRef.current++;
    setIsLoading(false);
    setError(null);
    setData(null);
  }, []);

  const execute = useCallback(async (args?: TArgs): Promise<TResult | null> => {
    const currentId = ++executionIdRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await actionRef.current(args as TArgs);
      if (isMountedRef.current && currentId === executionIdRef.current) {
        setData(result);
        setIsLoading(false);
        optionsRef.current?.onSuccess?.(result, args as TArgs);
        return result;
      }
      return null;
    } catch (err: unknown) {
      if (!isMountedRef.current || currentId !== executionIdRef.current) {
        return null;
      }
      const normalizedError =
        err instanceof Error
          ? err
          : new Error(
              typeof err === "string"
                ? err
                : typeof err === "object" &&
                    err !== null &&
                    "message" in err &&
                    typeof (err as { message: unknown }).message === "string"
                  ? (err as { message: string }).message
                  : (optionsRef.current?.errorMessageFallback ??
                    "An unexpected error occurred"),
            );
      setError(normalizedError.message);
      setIsLoading(false);
      optionsRef.current?.onError?.(normalizedError, args as TArgs);
      return null;
    }
  }, []) as UseAsyncActionExecute<TResult, TArgs>;

  return {
    isLoading,
    error,
    data,
    execute,
    reset,
    setError,
  };
}
