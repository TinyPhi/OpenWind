// @vitest-environment jsdom
import React, { useState } from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SearchableMultiSelect } from "./searchable-multi-select.js";

const OPTIONS = [
  { value: "a", label: "Asha Rao" },
  { value: "b", label: "Ben Cole" },
  { value: "c", label: "Chen Wu" },
];

function Harness({ max }: { max?: number }): React.ReactElement {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <>
      <SearchableMultiSelect
        ariaLabel="Pick"
        options={OPTIONS}
        selected={selected}
        onChange={setSelected}
        {...(max === undefined ? {} : { max })}
      />
      <output data-testid="out">{selected.join(",")}</output>
    </>
  );
}

afterEach(cleanup);

describe("SearchableMultiSelect", () => {
  it("filters by the search text", () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText("Pick"));
    fireEvent.change(screen.getByLabelText("Pick search"), {
      target: { value: "ch" },
    });
    expect(screen.queryByLabelText("Asha Rao")).toBeNull();
    expect(screen.getByLabelText("Chen Wu")).toBeTruthy();
  });

  it("keeps the order people were picked in and unticks on a second click", () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText("Pick"));
    fireEvent.click(screen.getByLabelText("Chen Wu"));
    fireEvent.click(screen.getByLabelText("Asha Rao"));
    expect(screen.getByTestId("out").textContent).toBe("c,a");
    fireEvent.click(screen.getByLabelText("Chen Wu"));
    expect(screen.getByTestId("out").textContent).toBe("a");
  });

  it("stops adding at the maximum", () => {
    render(<Harness max={1} />);
    fireEvent.click(screen.getByLabelText("Pick"));
    fireEvent.click(screen.getByLabelText("Asha Rao"));
    fireEvent.click(screen.getByLabelText("Ben Cole"));
    expect(screen.getByTestId("out").textContent).toBe("a");
  });
});
