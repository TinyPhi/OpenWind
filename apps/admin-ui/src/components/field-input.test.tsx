import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("../lib/api.js", () => ({ fetchWithAuth: vi.fn(), API_URL: "" }));
vi.mock("./user-ref-picker.js", () => ({
  UserRefPicker: () => <div data-testid="user-ref-picker" />,
}));
vi.mock("./entity-ref-picker.js", () => ({
  EntityRefPicker: ({
    targetEntityTypeName,
  }: {
    targetEntityTypeName: string;
  }) => <div data-testid="entity-ref-picker">{targetEntityTypeName}</div>,
}));
vi.mock("./file-field-picker.js", () => ({
  FileFieldPicker: ({
    multiple,
    moduleSlug,
  }: {
    multiple: boolean;
    moduleSlug: string;
  }) => (
    <div data-testid="file-field-picker">
      {multiple ? "multiple" : "single"}:{moduleSlug}
    </div>
  ),
}));

const { FieldInput } = await import("./field-input.js");

afterEach(() => cleanup());

const baseField = {
  id: "f1",
  name: "field1",
  label: "Field One",
  isSystem: false,
  isRequired: false,
  config: {},
};

describe("FieldInput", () => {
  it("renders a number input for number fields", () => {
    render(
      <FieldInput
        moduleSlug="helpdesk"
        entityId={undefined}
        field={{ ...baseField, fieldType: "number" }}
        value={5}
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("5");
  });

  it("renders a checkbox for boolean fields with portal className", () => {
    const { container } = render(
      <FieldInput
        moduleSlug="helpdesk"
        entityId={undefined}
        field={{ ...baseField, fieldType: "boolean" }}
        value={true}
        classPrefix="portal"
        onChange={vi.fn()}
      />,
    );
    expect(container.querySelector(".portal-checkbox")).not.toBeNull();
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", true);
  });

  it("renders amount+currency controls for currency fields", () => {
    const onChange = vi.fn();
    render(
      <FieldInput
        moduleSlug="helpdesk"
        entityId={undefined}
        field={{
          ...baseField,
          fieldType: "currency",
          config: { allowedCurrencies: ["USD", "EUR"] },
        }}
        value={{ amount: 10, currency: "EUR" }}
        onChange={onChange}
      />,
    );
    const amountInput = screen.getByPlaceholderText("0.00") as HTMLInputElement;
    expect(amountInput.value).toBe("10");
    fireEvent.change(amountInput, { target: { value: "20" } });
    expect(onChange).toHaveBeenCalledWith({ amount: 20, currency: "EUR" });
  });

  it("renders formula fields as disabled read-only text", () => {
    render(
      <FieldInput
        moduleSlug="helpdesk"
        entityId={undefined}
        field={{ ...baseField, fieldType: "formula" }}
        value={42}
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByDisplayValue("42") as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it("renders lookup fields as disabled read-only text with a dash placeholder when empty", () => {
    render(
      <FieldInput
        moduleSlug="helpdesk"
        entityId={undefined}
        field={{ ...baseField, fieldType: "lookup" }}
        value={null}
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByDisplayValue("—") as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it("delegates user_ref fields to UserRefPicker", () => {
    render(
      <FieldInput
        moduleSlug="helpdesk"
        entityId={undefined}
        field={{ ...baseField, fieldType: "user_ref" }}
        value={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("user-ref-picker")).not.toBeNull();
  });

  it("delegates entity_ref fields to EntityRefPicker with the resolved target type name", () => {
    render(
      <FieldInput
        moduleSlug="helpdesk"
        entityId={undefined}
        field={{
          ...baseField,
          fieldType: "entity_ref",
          config: { target_entity_type: "ticket" },
        }}
        value={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("entity-ref-picker").textContent).toBe("ticket");
  });

  it("delegates file fields to FileFieldPicker with multiple=false", () => {
    render(
      <FieldInput
        moduleSlug="helpdesk"
        entityId={undefined}
        field={{ ...baseField, fieldType: "file" }}
        value={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("file-field-picker").textContent).toBe(
      "single:helpdesk",
    );
  });

  it("delegates files fields to FileFieldPicker with multiple=true", () => {
    render(
      <FieldInput
        moduleSlug="helpdesk"
        entityId={undefined}
        field={{ ...baseField, fieldType: "files" }}
        value={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("file-field-picker").textContent).toBe(
      "multiple:helpdesk",
    );
  });

  it("marks the control required when the required prop is set", () => {
    render(
      <FieldInput
        moduleSlug="helpdesk"
        entityId={undefined}
        field={{ ...baseField, fieldType: "text" }}
        value=""
        required
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("textbox")).toHaveProperty("required", true);
  });
});
