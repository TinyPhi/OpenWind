import type { ReactElement } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { PluginSlot } from "./plugin-slot.js";

const mockLogPluginSlotError =
  vi.fn<(pluginSlug: string, slotName: string, error: Error) => void>();

vi.mock("../lib/plugin-slot-errors.js", () => ({
  logPluginSlotError: (pluginSlug: string, slotName: string, error: Error) =>
    mockLogPluginSlotError(pluginSlug, slotName, error),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function WorkingComponent(): ReactElement {
  return <div>plugin content rendered fine</div>;
}

function ThrowingComponent(): ReactElement {
  throw new Error("plugin blew up");
}

describe("PluginSlot", () => {
  it("renders the loaded component when loading and rendering both succeed", async () => {
    render(
      <PluginSlot
        pluginSlug="good_plugin"
        slotName="ticket-header"
        load={() => Promise.resolve(WorkingComponent)}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("plugin content rendered fine")).toBeDefined(),
    );
    expect(mockLogPluginSlotError).not.toHaveBeenCalled();
  });

  it("catches a render-time throw, reports it, and does not crash the host page", async () => {
    // React logs the caught error to console.error too — suppress that noise
    // for this test without hiding a real assertion failure.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(
      <div>
        <span>host content that must survive</span>
        <PluginSlot
          pluginSlug="bad_plugin"
          slotName="ticket-header"
          load={() => Promise.resolve(ThrowingComponent)}
        />
      </div>,
    );

    await waitFor(() =>
      expect(mockLogPluginSlotError).toHaveBeenCalledWith(
        "bad_plugin",
        "ticket-header",
        expect.objectContaining({ message: "plugin blew up" }),
      ),
    );

    // The host content around the failed slot is still there.
    expect(screen.getByText("host content that must survive")).toBeDefined();

    consoleError.mockRestore();
  });

  it("catches a load() rejection the same way as a render-time throw", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(
      <PluginSlot
        pluginSlug="load_fail_plugin"
        slotName="ticket-header"
        load={() => Promise.reject(new Error("remote fetch failed"))}
      />,
    );

    await waitFor(() =>
      expect(mockLogPluginSlotError).toHaveBeenCalledWith(
        "load_fail_plugin",
        "ticket-header",
        expect.objectContaining({ message: "remote fetch failed" }),
      ),
    );

    consoleError.mockRestore();
  });

  it("renders the fallback when a plugin fails, if one was provided", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(
      <PluginSlot
        pluginSlug="bad_plugin"
        slotName="ticket-header"
        load={() => Promise.resolve(ThrowingComponent)}
        fallback={<span>this widget is unavailable</span>}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("this widget is unavailable")).toBeDefined(),
    );

    consoleError.mockRestore();
  });

  it("one failing slot does not affect a sibling slot rendered alongside it", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(
      <div>
        <PluginSlot
          pluginSlug="bad_plugin"
          slotName="slot-a"
          load={() => Promise.resolve(ThrowingComponent)}
        />
        <PluginSlot
          pluginSlug="good_plugin"
          slotName="slot-b"
          load={() => Promise.resolve(WorkingComponent)}
        />
      </div>,
    );

    await waitFor(() =>
      expect(screen.getByText("plugin content rendered fine")).toBeDefined(),
    );
    expect(mockLogPluginSlotError).toHaveBeenCalledTimes(1);

    consoleError.mockRestore();
  });
});
