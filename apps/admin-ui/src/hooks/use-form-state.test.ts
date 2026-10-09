import type { ChangeEvent } from "react";
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFormState } from "./use-form-state.js";

interface TestForm {
  name: string;
  email: string;
  isActive: boolean;
  age: number;
}

const INITIAL_FORM: TestForm = {
  name: "Alice",
  email: "alice@example.com",
  isActive: true,
  age: 30,
};

describe("useFormState", () => {
  it("initializes with initial values and is not dirty", () => {
    const { result } = renderHook(() =>
      useFormState<TestForm>({ initialValues: INITIAL_FORM }),
    );

    expect(result.current.values).toEqual(INITIAL_FORM);
    expect(result.current.isDirty).toBe(false);
  });

  it("updates individual field with setFieldValue and sets isDirty", () => {
    const { result } = renderHook(() =>
      useFormState<TestForm>({ initialValues: INITIAL_FORM }),
    );

    act(() => {
      result.current.setFieldValue("name", "Bob");
    });

    expect(result.current.values.name).toBe("Bob");
    expect(result.current.isDirty).toBe(true);
  });

  it("supports updater function in setFieldValue", () => {
    const { result } = renderHook(() =>
      useFormState<TestForm>({ initialValues: INITIAL_FORM }),
    );

    act(() => {
      result.current.setFieldValue("age", (prev) => prev + 1);
    });

    expect(result.current.values.age).toBe(31);
    expect(result.current.isDirty).toBe(true);
  });

  it("updates multiple fields with setValues", () => {
    const { result } = renderHook(() =>
      useFormState<TestForm>({ initialValues: INITIAL_FORM }),
    );

    act(() => {
      result.current.setValues({ name: "Charlie", isActive: false });
    });

    expect(result.current.values.name).toBe("Charlie");
    expect(result.current.values.isActive).toBe(false);
    expect(result.current.values.email).toBe("alice@example.com");
    expect(result.current.isDirty).toBe(true);
  });

  it("updates field using handleChange event handler", () => {
    const { result } = renderHook(() =>
      useFormState<TestForm>({ initialValues: INITIAL_FORM }),
    );

    const syntheticEvent = {
      target: { value: "alice_updated@example.com" },
    } as unknown as ChangeEvent<HTMLInputElement>;

    act(() => {
      result.current.handleChange("email")(syntheticEvent);
    });

    expect(result.current.values.email).toBe("alice_updated@example.com");
    expect(result.current.isDirty).toBe(true);
  });

  it("updates boolean field using handleCheckboxChange", () => {
    const { result } = renderHook(() =>
      useFormState<TestForm>({ initialValues: INITIAL_FORM }),
    );

    const syntheticEvent = {
      target: { checked: false },
    } as unknown as ChangeEvent<HTMLInputElement>;

    act(() => {
      result.current.handleCheckboxChange("isActive")(syntheticEvent);
    });

    expect(result.current.values.isActive).toBe(false);
    expect(result.current.isDirty).toBe(true);
  });

  it("resets form back to initial state", () => {
    const { result } = renderHook(() =>
      useFormState<TestForm>({ initialValues: INITIAL_FORM }),
    );

    act(() => {
      result.current.setFieldValue("name", "Modified");
    });
    expect(result.current.isDirty).toBe(true);

    act(() => {
      result.current.reset();
    });

    expect(result.current.values).toEqual(INITIAL_FORM);
    expect(result.current.isDirty).toBe(false);
  });

  it("resets form to new values when passed to reset()", () => {
    const { result } = renderHook(() =>
      useFormState<TestForm>({ initialValues: INITIAL_FORM }),
    );

    const newForm: TestForm = {
      name: "David",
      email: "david@example.com",
      isActive: false,
      age: 25,
    };

    act(() => {
      result.current.reset(newForm);
    });

    expect(result.current.values).toEqual(newForm);
    expect(result.current.isDirty).toBe(false);
  });
});
