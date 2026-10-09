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

  const [initialSnapshot, setInitialSnapshot] = useState<TForm>(getInitial);
  const [values, setFormValues] = useState<TForm>(initialSnapshot);

  const isDirty = useMemo((): boolean => {
    return JSON.stringify(values) !== JSON.stringify(initialSnapshot);
  }, [values, initialSnapshot]);

  const setFieldValue = useCallback(
    <K extends keyof TForm>(
      field: K,
      value: TForm[K] | ((prev: TForm[K]) => TForm[K]),
    ): void => {
      setFormValues((prev) => {
        const nextVal =
          typeof value === "function"
            ? (value as (prevVal: TForm[K]) => TForm[K])(prev[field])
            : value;
        if (prev[field] === nextVal) return prev;
        return { ...prev, [field]: nextVal };
      });
    },
    [],
  );

  const setValues = useCallback(
    (next: Partial<TForm> | ((prev: TForm) => TForm)): void => {
      setFormValues((prev) => {
        const incoming = typeof next === "function" ? next(prev) : next;
        const hasChanges = Object.keys(incoming).some((k) => {
          const key = k as keyof TForm;
          return prev[key] !== incoming[key];
        });
        if (!hasChanges) return prev;
        return { ...prev, ...incoming };
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

  const handleSubmit = useCallback(
    async (event?: FormEvent): Promise<void> => {
      event?.preventDefault();
      await optionsRef.current.onSubmit?.(values);
    },
    [values],
  );

  const reset = useCallback(
    (nextValues?: TForm): void => {
      const target = nextValues ?? getInitial();
      setInitialSnapshot(target);
      setFormValues(target);
    },
    [getInitial],
  );

  return {
    values,
    isDirty,
    setFieldValue,
    setValues,
    handleChange,
    handleCheckboxChange,
    handleSubmit,
    reset,
  };
}
