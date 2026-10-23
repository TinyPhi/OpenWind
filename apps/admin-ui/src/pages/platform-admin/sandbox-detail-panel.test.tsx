import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { SandboxView } from "./format.js";

vi.mock("./sandbox-row-actions.js", () => ({
  SandboxRowActions: (props: { tenantName: string; onDone: () => void }) => (
    <button type="button" onClick={props.onDone}>
      Actions for {props.tenantName}
    </button>
  ),
}));
vi.mock("./activity-timeline.js", () => ({
  ActivityTimeline: (props: { targetTenantId?: string }) => (
    <div>Timeline {props.targetTenantId}</div>
  ),
}));

const { SandboxDetailPanel } = await import("./sandbox-detail-panel.js");

const SANDBOX: SandboxView = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme Sandbox",
  isSandbox: true,
  createdAt: "2026-10-01T00:00:00Z",
  trialStatus: "expired",
  trialEndsAt: new Date(Date.now() - 2 * 86_400_000 - 3_600_000).toISOString(),
  logo: null,
};

function renderPanel(sandbox: SandboxView = SANDBOX): {
  onClose: ReturnType<typeof vi.fn>;
  onActionDone: ReturnType<typeof vi.fn>;
} {
  const onClose = vi.fn();
  const onActionDone = vi.fn();
  render(
    <SandboxDetailPanel
      sandbox={sandbox}
      tenantNames={new Map()}
      currentUserId="pa-1"
      refreshKey={0}
      onClose={onClose}
      onActionDone={onActionDone}
    />,
  );
  return { onClose, onActionDone };
}

describe("SandboxDetailPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the sandbox's metadata, trial end, actions and own timeline", () => {
    renderPanel();
    expect(screen.getByText(SANDBOX.id)).toBeTruthy();
    expect(screen.getByText("Trial expired")).toBeTruthy();
    expect(screen.getByText(/Expired 2 days ago/)).toBeTruthy();
    expect(screen.getByText("Actions for Acme Sandbox")).toBeTruthy();
    expect(screen.getByText(`Timeline ${SANDBOX.id}`)).toBeTruthy();
  });

  it("says when no trial end is set", () => {
    renderPanel({ ...SANDBOX, trialStatus: "none", trialEndsAt: null });
    expect(screen.getByText("No trial end set")).toBeTruthy();
  });

  it("reports a completed action to the parent", () => {
    const { onActionDone } = renderPanel();
    fireEvent.click(screen.getByText("Actions for Acme Sandbox"));
    expect(onActionDone).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const { onClose } = renderPanel();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
