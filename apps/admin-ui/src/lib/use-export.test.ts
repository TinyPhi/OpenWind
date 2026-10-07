import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useExport } from "./use-export.js";

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("./api.js", () => ({
  API_URL: "http://api.test",
  fetchWithAuth: vi.fn(),
  fetchRawWithAuth: vi.fn(),
}));

import { fetchWithAuth, fetchRawWithAuth } from "./api.js";
const mockPoll = vi.mocked(fetchWithAuth);
const mockInitiate = vi.mocked(fetchRawWithAuth);

// ── Helpers ────────────────────────────────────────────────────────────────────

function syncResponse(
  status: number,
  body?: unknown,
  ok = true,
): Partial<Response> {
  return {
    status,
    ok,
    json: () => Promise.resolve(body),
    blob: () => Promise.resolve(new Blob(["data"])),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("useExport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(document.body, "appendChild").mockImplementation((el) => el);
    vi.spyOn(document.body, "removeChild").mockImplementation((el) => el);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts with status idle and no error or download URL", () => {
    const { result } = renderHook(() => useExport("et-123"));
    expect(result.current.exportStatus).toBe("idle");
    expect(result.current.exportError).toBeNull();
    expect(result.current.exportDownloadUrl).toBeNull();
  });

  it("does nothing when entityTypeId is undefined", async () => {
    const { result } = renderHook(() => useExport(undefined));
    await act(async () => {
      await result.current.handleExport("csv");
    });
    expect(result.current.exportStatus).toBe("idle");
    expect(mockInitiate).not.toHaveBeenCalled();
  });

  // ── sync export path ──────────────────────────────────────────────────────

  it("returns to idle after a synchronous download completes (200)", async () => {
    mockInitiate.mockResolvedValue(syncResponse(200) as Response);

    const { result } = renderHook(() => useExport("et-123"));
    await act(async () => {
      await result.current.handleExport("csv");
    });

    expect(result.current.exportStatus).toBe("idle");
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  // ── async export path ─────────────────────────────────────────────────────

  it("transitions to polling when the server returns 202", async () => {
    mockInitiate.mockResolvedValue(
      syncResponse(202, { jobId: "job-abc" }, false) as Response,
    );

    const { result } = renderHook(() => useExport("et-123"));
    await act(async () => {
      await result.current.handleExport("xlsx");
    });

    expect(result.current.exportStatus).toBe("polling");
  });

  it("transitions from polling to ready when the job completes", async () => {
    mockInitiate.mockResolvedValue(
      syncResponse(202, { jobId: "job-abc" }, false) as Response,
    );
    mockPoll.mockResolvedValue({
      data: {
        status: "complete",
        downloadUrl: "/exports/job-abc/download?file=1",
      },
    });

    const { result } = renderHook(() => useExport("et-123"));
    await act(async () => {
      await result.current.handleExport("csv");
    });
    expect(result.current.exportStatus).toBe("polling");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });

    expect(result.current.exportStatus).toBe("ready");
    expect(result.current.exportDownloadUrl).toBe(
      "/exports/job-abc/download?file=1",
    );
  });

  it("transitions from polling to error when the job fails", async () => {
    mockInitiate.mockResolvedValue(
      syncResponse(202, { jobId: "job-abc" }, false) as Response,
    );
    mockPoll.mockResolvedValue({ data: { status: "failed" } });

    const { result } = renderHook(() => useExport("et-123"));
    await act(async () => {
      await result.current.handleExport("csv");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });

    expect(result.current.exportStatus).toBe("error");
    expect(result.current.exportError).toBeTruthy();
  });

  it("re-polls after a pending response and resolves on the next tick", async () => {
    mockInitiate.mockResolvedValue(
      syncResponse(202, { jobId: "job-abc" }, false) as Response,
    );
    mockPoll
      .mockResolvedValueOnce({ data: { status: "pending" } })
      .mockResolvedValueOnce({
        data: {
          status: "complete",
          downloadUrl: "/exports/job-abc/download?file=1",
        },
      });

    const { result } = renderHook(() => useExport("et-123"));
    await act(async () => {
      await result.current.handleExport("csv");
    });

    // First poll: pending
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(result.current.exportStatus).toBe("polling");

    // Second poll: complete
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(result.current.exportStatus).toBe("ready");
  });

  it("transitions to error when the poll fetch throws", async () => {
    mockInitiate.mockResolvedValue(
      syncResponse(202, { jobId: "job-abc" }, false) as Response,
    );
    mockPoll.mockRejectedValue(new Error("network error"));

    const { result } = renderHook(() => useExport("et-123"));
    await act(async () => {
      await result.current.handleExport("csv");
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });

    expect(result.current.exportStatus).toBe("error");
    expect(result.current.exportError).toContain("check export status");
  });

  // ── error paths ───────────────────────────────────────────────────────────

  it("sets the specific EXPORT_TOO_LARGE message on 400", async () => {
    mockInitiate.mockResolvedValue(
      syncResponse(400, { error: "EXPORT_TOO_LARGE" }, false) as Response,
    );

    const { result } = renderHook(() => useExport("et-123"));
    await act(async () => {
      await result.current.handleExport("csv");
    });

    expect(result.current.exportStatus).toBe("error");
    expect(result.current.exportError).toContain("10,000");
  });

  it("sets the server message on any other 400", async () => {
    mockInitiate.mockResolvedValue(
      syncResponse(
        400,
        { error: "INVALID_FORMAT", message: "Unsupported format" },
        false,
      ) as Response,
    );

    const { result } = renderHook(() => useExport("et-123"));
    await act(async () => {
      await result.current.handleExport("pdf");
    });

    expect(result.current.exportStatus).toBe("error");
    expect(result.current.exportError).toBe("Unsupported format");
  });

  it("sets an error on unexpected non-ok status", async () => {
    mockInitiate.mockResolvedValue(syncResponse(500, {}, false) as Response);

    const { result } = renderHook(() => useExport("et-123"));
    await act(async () => {
      await result.current.handleExport("csv");
    });

    expect(result.current.exportStatus).toBe("error");
    expect(result.current.exportError).toContain("500");
  });

  // ── resetExport ───────────────────────────────────────────────────────────

  it("resetExport clears status, error, and downloadUrl", async () => {
    mockInitiate.mockResolvedValue(
      syncResponse(400, { error: "EXPORT_TOO_LARGE" }, false) as Response,
    );

    const { result } = renderHook(() => useExport("et-123"));
    await act(async () => {
      await result.current.handleExport("csv");
    });
    expect(result.current.exportStatus).toBe("error");

    act(() => {
      result.current.resetExport();
    });

    expect(result.current.exportStatus).toBe("idle");
    expect(result.current.exportError).toBeNull();
    expect(result.current.exportDownloadUrl).toBeNull();
  });

  // ── triggerAsyncDownload ──────────────────────────────────────────────────

  it("triggerAsyncDownload creates an anchor click and resets to idle", async () => {
    mockInitiate.mockResolvedValue(
      syncResponse(202, { jobId: "job-abc" }, false) as Response,
    );
    mockPoll.mockResolvedValue({
      data: {
        status: "complete",
        downloadUrl: "/exports/job-abc/download?file=1",
      },
    });

    const { result } = renderHook(() => useExport("et-123"));
    await act(async () => {
      await result.current.handleExport("csv");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(result.current.exportStatus).toBe("ready");

    mockInitiate.mockResolvedValue(syncResponse(200) as Response);

    const mockClick = vi.fn();
    vi.spyOn(document, "createElement").mockReturnValueOnce(
      Object.assign(document.createElement("a"), { click: mockClick }),
    );

    await act(async () => {
      await result.current.triggerAsyncDownload();
    });

    expect(mockInitiate).toHaveBeenCalledWith(
      "http://api.test/exports/job-abc/download?file=1",
    );
    expect(mockClick).toHaveBeenCalled();
    expect(result.current.exportStatus).toBe("idle");
    expect(result.current.exportDownloadUrl).toBeNull();
  });
});
