import React, { useState, useRef, useCallback } from "react";
import { fetchWithAuth, API_URL } from "../lib/api.js";
import type { StagedFile } from "../hooks/use-file-upload.js";

/* ── Types ─────────────────────────────────────────────────────── */

export type AttachmentFile = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  scanStatus: string;
  uploadedBy: string;
  createdAt: string;
};

/* ── Helpers ───────────────────────────────────────────────────── */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(mimeType: string): React.ReactElement {
  if (mimeType.startsWith("image/")) {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
    );
  }
  if (mimeType === "application/pdf") {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="9" y1="13" x2="15" y2="13" />
        <line x1="9" y1="17" x2="15" y2="17" />
      </svg>
    );
  }
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" />
      <polyline points="13 2 13 9 20 9" />
    </svg>
  );
}

function canPreview(mimeType: string): boolean {
  return (
    mimeType.startsWith("image/") ||
    mimeType === "application/pdf" ||
    mimeType.startsWith("text/") ||
    mimeType === "application/json"
  );
}

/* ── FileChip ──────────────────────────────────────────────────── */

export function FileChip({
  file,
  onPreview,
  onDelete,
  canDelete,
}: {
  file: AttachmentFile;
  onPreview: (file: AttachmentFile) => void;
  onDelete?: (fileId: string) => void;
  canDelete?: boolean;
}): React.ReactElement {
  const isDeleted = file.scanStatus === "deleted";
  const isQuarantined = file.scanStatus === "quarantined";
  const isClean = file.scanStatus === "clean";
  const isPending = file.scanStatus === "pending";

  return (
    <div
      className={`fa-chip ${isQuarantined ? "fa-chip-blocked" : isPending ? "fa-chip-pending" : ""}`}
      title={
        isQuarantined ? "File blocked — malware detected" : file.originalName
      }
    >
      <span className="fa-chip-icon">{fileIcon(file.mimeType)}</span>
      <span className="fa-chip-name">{file.originalName}</span>
      {!isDeleted && !isQuarantined && (
        <span className="fa-chip-size">{formatBytes(file.sizeBytes)}</span>
      )}
      {isQuarantined && (
        <span className="fa-chip-tag fa-chip-tag-blocked">Blocked</span>
      )}
      {isPending && (
        <span className="fa-chip-tag fa-chip-tag-pending">Scanning…</span>
      )}
      {isClean && canPreview(file.mimeType) && (
        <button
          type="button"
          className="fa-chip-action"
          onClick={() => onPreview(file)}
          title="Preview"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      )}
      {isClean && !canPreview(file.mimeType) && (
        <a
          className="fa-chip-action"
          href={`${API_URL}/files/${file.id}`}
          title="Download"
          onClick={(e) => {
            e.preventDefault();
            void (async () => {
              try {
                const res = (await fetchWithAuth(
                  `${API_URL}/files/${file.id}`,
                )) as {
                  data: { downloadUrl: string };
                };
                window.open(res.data.downloadUrl, "_blank");
              } catch {
                alert("Could not get download link.");
              }
            })();
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </a>
      )}
      {canDelete && onDelete && !isQuarantined && (
        <button
          type="button"
          className="fa-chip-action fa-chip-delete"
          onClick={() => onDelete(file.id)}
          title="Remove"
        >
          ×
        </button>
      )}
    </div>
  );
}

/* ── StagedFileChip (pre-scan, during upload) ──────────────────── */

export function StagedFileChip({
  file,
  onRemove,
}: {
  file: StagedFile;
  onRemove: (fileId: string) => void;
}): React.ReactElement {
  const isTemp = file.fileId.startsWith("temp-");
  const isUploading = isTemp || file.uploadProgress < 100;

  return (
    <div
      className={`fa-chip fa-chip-staged ${file.scanStatus === "quarantined" ? "fa-chip-blocked" : file.scanStatus === "scan_failed" ? "fa-chip-blocked" : ""}`}
    >
      {file.previewUrl ? (
        <img src={file.previewUrl} className="fa-chip-thumb" alt="" />
      ) : (
        <span className="fa-chip-icon">{fileIcon(file.mimeType)}</span>
      )}
      <span className="fa-chip-name">{file.originalName}</span>
      {isUploading ? (
        <span className="fa-chip-tag fa-chip-tag-pending">
          {file.uploadProgress < 100 ? `${file.uploadProgress}%` : "Uploaded"}
        </span>
      ) : file.scanStatus === "pending" ? (
        <span className="fa-chip-tag fa-chip-tag-pending">Scanning…</span>
      ) : file.scanStatus === "clean" ? (
        <span className="fa-chip-tag fa-chip-tag-clean">Ready</span>
      ) : file.scanStatus === "quarantined" ? (
        <span className="fa-chip-tag fa-chip-tag-blocked">Blocked</span>
      ) : (
        <span className="fa-chip-tag fa-chip-tag-blocked">Scan failed</span>
      )}
      <button
        type="button"
        className="fa-chip-action fa-chip-delete"
        onClick={() => onRemove(file.fileId)}
        title="Remove"
      >
        ×
      </button>
    </div>
  );
}

/* ── AttachmentUploadZone ──────────────────────────────────────── */

export function AttachmentUploadZone({
  onFiles,
  disabled,
}: {
  onFiles: (files: File[]) => void | Promise<void>;
  disabled?: boolean;
}): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      if (disabled) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length) void onFiles(files);
    },
    [onFiles, disabled],
  );

  return (
    <div
      className={`fa-upload-zone ${dragging ? "fa-upload-zone-active" : ""} ${disabled ? "fa-upload-zone-disabled" : ""}`}
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      role="button"
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ opacity: 0.4 }}
      >
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>
      <span>Click or drag files to attach</span>
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) {
            void onFiles(files);
            e.target.value = "";
          }
        }}
      />
    </div>
  );
}

/* ── FilePreviewModal ──────────────────────────────────────────── */

export function FilePreviewModal({
  file,
  onClose,
}: {
  file: AttachmentFile;
  onClose: () => void;
}): React.ReactElement {
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isImage = file.mimeType.startsWith("image/");
  const isPdf = file.mimeType === "application/pdf";
  const isText =
    file.mimeType.startsWith("text/") || file.mimeType === "application/json";

  React.useEffect(() => {
    const ctrl = new AbortController();
    async function load(): Promise<void> {
      try {
        const res = (await fetchWithAuth(`${API_URL}/files/${file.id}`)) as {
          data: { downloadUrl: string };
        };
        if (ctrl.signal.aborted) return;
        setDownloadUrl(res.data.downloadUrl);

        if (isText) {
          const r = await fetch(res.data.downloadUrl, { signal: ctrl.signal });
          const text = await r.text();
          setTextContent(text.slice(0, 50_000));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load file");
      } finally {
        setLoading(false);
      }
    }
    void load();
    return () => {
      ctrl.abort();
    };
  }, [file.id, isText]);

  return (
    <div className="fa-modal-backdrop" onClick={onClose}>
      <div className="fa-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fa-modal-header">
          <span className="fa-modal-title">{file.originalName}</span>
          <span className="fa-modal-size">{formatBytes(file.sizeBytes)}</span>
          {downloadUrl && (
            <a
              href={downloadUrl}
              download={file.originalName}
              className="fa-modal-download"
              title="Download"
              target="_blank"
              rel="noreferrer"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </a>
          )}
          <button type="button" className="fa-modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="fa-modal-body">
          {loading && <p className="fa-modal-hint">Loading…</p>}
          {error && (
            <p className="fa-modal-hint fa-modal-hint-error">{error}</p>
          )}
          {!loading && !error && downloadUrl && (
            <>
              {isImage && (
                <div className="fa-modal-image-wrap">
                  <img
                    src={downloadUrl}
                    alt={file.originalName}
                    className="fa-modal-image"
                  />
                </div>
              )}
              {isPdf && (
                <embed
                  src={downloadUrl}
                  type="application/pdf"
                  className="fa-modal-embed"
                />
              )}
              {isText && textContent !== null && (
                <pre className="fa-modal-text">{textContent}</pre>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
