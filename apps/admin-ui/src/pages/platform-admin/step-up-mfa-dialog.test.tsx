import { describe, it, expect, vi, afterEach } from "vitest";
import "../../i18n.js";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type React from "react";

// The code flow itself is covered by otp-verification.test.tsx; the dialog wraps it.
let captured: {
  onVerified: () => void;
  secondaryAction?: React.ReactNode;
} | null = null;
vi.mock("./otp-verification.js", () => ({
  OtpVerification: (props: {
    onVerified: () => void;
    secondaryAction?: React.ReactNode;
  }) => {
    captured = props;
    return <div data-testid="otp-flow">{props.secondaryAction}</div>;
  },
}));

const { StepUpMfaDialog } = await import("./step-up-mfa-dialog.js");

function renderDialog(open = true): {
  onVerified: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
} {
  const onVerified = vi.fn();
  const onCancel = vi.fn();
  render(
    <StepUpMfaDialog open={open} onVerified={onVerified} onCancel={onCancel} />,
  );
  return { onVerified, onCancel };
}

describe("StepUpMfaDialog (#865)", () => {
  afterEach(() => {
    cleanup();
    captured = null;
  });

  it("explains why a fresh code is needed and runs the code flow", () => {
    renderDialog();

    expect(screen.getByText("Confirm it's you")).toBeTruthy();
    expect(screen.getByText(/can't be undone/)).toBeTruthy();
    expect(screen.getByTestId("otp-flow")).toBeTruthy();
  });

  it("hands control back to the caller once the code is verified", () => {
    const { onVerified } = renderDialog();

    captured?.onVerified();

    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it("offers Cancel beside the code flow", () => {
    const { onCancel } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not start the code flow (or send a code) while closed", () => {
    renderDialog(false);

    expect(screen.queryByTestId("otp-flow")).toBeNull();
  });
});
