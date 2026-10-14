import {
  useState,
  useCallback,
  useMemo,
  useRef,
  type ChangeEvent,
  type FormEvent,
} from "react";

export interface UseFormStateOptions<TForm extends object> {
  readonly initialValues: TForm | (() => TForm);
  readonly onSubmit?: (values: TForm) => Promise<void> | void;
}

export interface UseFormStateReturn<TForm extends object> {
  readonly values: TForm;
  readonly isDirty: boolean;
  readonly setFieldValue: <K extends keyof TForm>(
    field: K,
    value: TForm[K] | ((prev: TForm[K]) => TForm[K]),
  ) => void;
  readonly setValues: (next: Partial<TForm> | ((prev: TForm) => TForm)) => void;
  readonly handleChange: (
    field: keyof TForm,
  ) => (
    event: ChangeEvent<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >,
  ) => void;
  readonly handleCheckboxChange: (
    field: keyof TForm,
  ) => (event: ChangeEvent<HTMLInputElement>) => void;
  readonly handleSubmit: (event?: FormEvent) => Promise<void>;
  readonly reset: (nextValues?: TForm) => void;
}

interface FormStateContainer<TForm> {
  readonly initialSnapshot: TForm;
  readonly values: TForm;
}

export function useFormState<TForm extends object>(
  options: UseFormStateOptions<TForm>,
): UseFormStateReturn<TForm> {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const getInitial = useCallback((): TForm => {
    return typeof optionsRef.current.initialValues === "function"
      ? (optionsRef.current.initialValues as () => TForm)()
      : optionsRef.current.initialValues;
  }, []);

  const [formState, setFormState] = useState<FormStateContainer<TForm>>(() => {
    const initial = getInitial();
    return { initialSnapshot: initial, values: initial };
  });

  const valuesRef = useRef(formState.values);
  valuesRef.current = formState.values;

  const isDirty = useMemo((): boolean => {
    const { values, initialSnapshot } = formState;
    const currentKeys = Object.keys(values) as Array<keyof TForm>;
    const snapshotKeys = Object.keys(initialSnapshot) as Array<keyof TForm>;

    if (currentKeys.length !== snapshotKeys.length) return true;

    const allKeys = new Set<keyof TForm>([...currentKeys, ...snapshotKeys]);

    for (const key of allKeys) {
      if (values[key] !== initialSnapshot[key]) return true;
    }

    return false;
  }, [formState]);

  const setFieldValue = useCallback(
    <K extends keyof TForm>(
      field: K,
      value: TForm[K] | ((prev: TForm[K]) => TForm[K]),
    ): void => {
      setFormState((prev) => {
        const nextVal =
          typeof value === "function"
            ? (value as (prevVal: TForm[K]) => TForm[K])(prev.values[field])
            : value;
        if (prev.values[field] === nextVal) return prev;
        return {
          ...prev,
          values: { ...prev.values, [field]: nextVal },
        };
      });
    },
    [],
  );

  const setValues = useCallback(
    (next: Partial<TForm> | ((prev: TForm) => TForm)): void => {
      setFormState((prev) => {
        const incoming = typeof next === "function" ? next(prev.values) : next;
        const hasChanges = Object.keys(incoming).some((k) => {
          const key = k as keyof TForm;
          return prev.values[key] !== incoming[key];
        });
        if (!hasChanges) return prev;
        return {
          ...prev,
          values: { ...prev.values, ...incoming },
        };
      });
    },
    [],
  );

  const handleChange = useCallback(
    (field: keyof TForm) =>
      (
        event: ChangeEvent<
          HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
        >,
      ): void => {
        const nextVal = event.target.value as TForm[typeof field];
        setFieldValue(field, nextVal);
      },
    [setFieldValue],
  );

  const handleCheckboxChange = useCallback(
    (field: keyof TForm) =>
      (event: ChangeEvent<HTMLInputElement>): void => {
        const isChecked = event.target.checked as TForm[typeof field];
        setFieldValue(field, isChecked);
      },
    [setFieldValue],
  );

  const handleSubmit = useCallback(async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    await optionsRef.current.onSubmit?.(valuesRef.current);
  }, []);

  const reset = useCallback(
    (nextValues?: TForm): void => {
      const target = nextValues ?? getInitial();
      setFormState({
        initialSnapshot: target,
        values: target,
      });
    },
    [getInitial],
  );

  return useMemo(
    () => ({
      values: formState.values,
      isDirty,
      setFieldValue,
      setValues,
      handleChange,
      handleCheckboxChange,
      handleSubmit,
      reset,
    }),
    [
      formState.values,
      isDirty,
      setFieldValue,
      setValues,
      handleChange,
      handleCheckboxChange,
      handleSubmit,
      reset,
    ],
  );
}
