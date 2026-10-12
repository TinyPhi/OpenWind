import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { TenantView } from "./format.js";

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

const { TenantDetailPanel } = await import("./tenant-detail-panel.js");

const SANDBOX: TenantView = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme Sandbox",
  isSandbox: true,
  createdAt: "2026-10-01T00:00:00Z",
  trialStatus: "expired",
};

function renderPanel(tenant: TenantView = SANDBOX): {
  onClose: ReturnType<typeof vi.fn>;
  onActionDone: ReturnType<typeof vi.fn>;
} {
  const onClose = vi.fn();
  const onActionDone = vi.fn();
  render(
    <TenantDetailPanel
      tenant={tenant}
      tenantNames={new Map()}
      currentUserId="pa-1"
      refreshKey={0}
      onClose={onClose}
      onActionDone={onActionDone}
    />,
  );
  return { onClose, onActionDone };
}

describe("TenantDetailPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the tenant's metadata, actions and own timeline for a sandbox", () => {
    renderPanel();
    expect(screen.getByText(SANDBOX.id)).toBeTruthy();
    expect(screen.getAllByText("Trial expired").length).toBeGreaterThan(0);
    expect(screen.getByText("Actions for Acme Sandbox")).toBeTruthy();
    expect(screen.getByText(`Timeline ${SANDBOX.id}`)).toBeTruthy();
  });

  it("offers no lifecycle actions for a customer tenant", () => {
    renderPanel({ ...SANDBOX, isSandbox: false, name: "Default Org" });
    expect(screen.queryByText("Actions for Default Org")).toBeNull();
    expect(screen.getByText(/view only/)).toBeTruthy();
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
