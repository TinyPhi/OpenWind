import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import type { StagedFile } from "../hooks/use-file-upload.js";

vi.mock("../lib/api.js", () => ({ fetchWithAuth: vi.fn(), API_URL: "" }));

interface UseFileUploadResult {
  stagedFiles: StagedFile[];
  addFiles: (files: File[]) => Promise<void>;
  removeFile: (fileId: string) => void;
  clearFiles: () => void;
  pendingCount: number;
  cleanFileIds: string[];
}

const useFileUpload = vi.fn<(...args: unknown[]) => UseFileUploadResult>();
vi.mock("../hooks/use-file-upload.js", () => ({
  useFileUpload: (...args: unknown[]) => useFileUpload(...args),
}));

const api = await import("../lib/api.js");
const fetchWithAuth = vi.mocked(api.fetchWithAuth);
const { FileFieldPicker } = await import("./file-field-picker.js");

function mockUpload(
  overrides: Partial<ReturnType<typeof useFileUpload>> = {},
): void {
  useFileUpload.mockReturnValue({
    stagedFiles: [],
    addFiles: vi.fn(),
    removeFile: vi.fn(),
    clearFiles: vi.fn(),
    pendingCount: 0,
    cleanFileIds: [],
    ...overrides,
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithAuth.mockResolvedValue({ data: [] });
  useFileUpload.mockReset();
  mockUpload();
});

afterEach(() => cleanup());

describe("FileFieldPicker", () => {
  it("renders the upload zone when empty (single mode)", () => {
    render(
      <FileFieldPicker
        value={null}
        onChange={vi.fn()}
        multiple={false}
        moduleSlug="helpdesk"
        entityId={undefined}
      />,
    );
    expect(screen.getByText(/drag/i, { exact: false })).toBeDefined();
  });

  it("hides the upload zone in single mode once a value is set", () => {
    render(
      <FileFieldPicker
        value="file-1"
        onChange={vi.fn()}
        multiple={false}
        moduleSlug="helpdesk"
        entityId="e1"
      />,
    );
    expect(screen.queryByText(/drag/i, { exact: false })).toBeNull();
  });

  it("keeps the upload zone visible in multiple mode even with existing values", () => {
    render(
      <FileFieldPicker
        value={["file-1"]}
        onChange={vi.fn()}
        multiple={true}
        moduleSlug="helpdesk"
        entityId="e1"
      />,
    );
    expect(screen.getByText(/drag/i, { exact: false })).not.toBeNull();
  });

  it("fetches and displays existing file metadata when entityId + value are set", async () => {
    fetchWithAuth.mockResolvedValue({
      data: [
        {
          id: "file-1",
          originalName: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048,
          scanStatus: "clean",
          uploadedBy: "u1",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "file-2",
          originalName: "other.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
          scanStatus: "clean",
          uploadedBy: "u1",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    render(
      <FileFieldPicker
        value="file-1"
        onChange={vi.fn()}
        multiple={false}
        moduleSlug="helpdesk"
        entityId="e1"
      />,
    );
    await waitFor(() => screen.getByText("report.pdf"));
    expect(fetchWithAuth).toHaveBeenCalledWith("/entities/e1/attachments");
    expect(screen.queryByText("other.pdf")).toBeNull();
  });

  it("does not fetch attachments when entityId is undefined (create flow)", () => {
    render(
      <FileFieldPicker
        value={null}
        onChange={vi.fn()}
        multiple={false}
        moduleSlug="helpdesk"
        entityId={undefined}
      />,
    );
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it("calls onChange with the new fileId once upload completes (single)", () => {
    mockUpload({ cleanFileIds: ["file-9"] });
    const onChange = vi.fn();
    render(
      <FileFieldPicker
        value={null}
        onChange={onChange}
        multiple={false}
        moduleSlug="helpdesk"
        entityId={undefined}
      />,
    );
    expect(onChange).toHaveBeenCalledWith("file-9");
  });

  // Regression test for the bug where a brand-new record's untouched field
  // arrives as `undefined` (no key yet in fieldValues) rather than `null` -
  // idsFromValue only checked `=== null`, so `undefined` fell through to
  // `[value]` i.e. `[undefined]`, which got spread into the onChange call
  // and serialized to a stray leading `null` in the submitted payload
  // (e.g. `[null, "fea6b18f-..."]`).
  it("calls onChange with just the new id when value starts as undefined (new-record create flow)", () => {
    mockUpload({ cleanFileIds: ["file-9"] });
    const onChange = vi.fn();
    render(
      <FileFieldPicker
        value={undefined}
        onChange={onChange}
        multiple={true}
        moduleSlug="helpdesk"
        entityId={undefined}
      />,
    );
    expect(onChange).toHaveBeenCalledWith(["file-9"]);
  });

  it("calls onChange with an appended array once upload completes (multiple)", () => {
    mockUpload({ cleanFileIds: ["file-1", "file-9"] });
    const onChange = vi.fn();
    render(
      <FileFieldPicker
        value={["file-1"]}
        onChange={onChange}
        multiple={true}
        moduleSlug="helpdesk"
        entityId={undefined}
      />,
    );
    expect(onChange).toHaveBeenCalledWith(["file-1", "file-9"]);
  });

  it("clears the field's value on remove without calling a delete endpoint", async () => {
    fetchWithAuth.mockResolvedValue({
      data: [
        {
          id: "file-1",
          originalName: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048,
          scanStatus: "clean",
          uploadedBy: "u1",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const onChange = vi.fn();
    render(
      <FileFieldPicker
        value="file-1"
        onChange={onChange}
        multiple={false}
        moduleSlug="helpdesk"
        entityId="e1"
      />,
    );
    await waitFor(() => screen.getByText("report.pdf"));
    fireEvent.click(screen.getByTitle("Remove"));
    expect(onChange).toHaveBeenCalledWith(null);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it("suppresses a StagedFileChip once its id also appears in existingFiles", async () => {
    fetchWithAuth.mockResolvedValue({
      data: [
        {
          id: "file-9",
          originalName: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048,
          scanStatus: "clean",
          uploadedBy: "u1",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    mockUpload({
      stagedFiles: [
        {
          fileId: "file-9",
          originalName: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2048,
          scanStatus: "clean",
          uploadProgress: 100,
        },
      ],
    });
    render(
      <FileFieldPicker
        value="file-9"
        onChange={vi.fn()}
        multiple={false}
        moduleSlug="helpdesk"
        entityId="e1"
      />,
    );
    await waitFor(() => screen.getByText("report.pdf"));
    // Only one chip for the file, not a StagedFileChip + FileChip pair.
    expect(screen.getAllByText("report.pdf")).toHaveLength(1);
  });
});
