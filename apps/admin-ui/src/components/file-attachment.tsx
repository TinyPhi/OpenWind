import React, { useState, useRef, useCallback } from "react";
import { fetchRawWithAuth, API_URL } from "../lib/api.js";
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

/**
 * GET /files/:id now streams bytes directly (no more presigned S3 URL), and
 * requires the Authorization header — which plain <img>/<embed> src
 * attributes can't send. Fetch the bytes as a Blob and hand back an object
 * URL instead; callers must revoke it when done.
 */
async function fetchFileBlob(fileId: string, inline?: boolean): Promise<Blob> {
  const res = await fetchRawWithAuth(
    `${API_URL}/files/${fileId}${inline ? "?inline=1" : ""}`,
  );
  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`);
  }
  return res.blob();
}

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

/* ── FileCard icon (large, format-specific) ────────────────────── */

type FormatBadge = { label: string; color: string; textColor: string };

function formatBadge(mimeType: string): FormatBadge {
  if (mimeType === "application/pdf")
    return { label: "PDF", color: "#e74c3c", textColor: "#fff" };
  if (
    mimeType.includes("wordprocessingml") ||
    mimeType === "application/msword"
  )
    return { label: "DOC", color: "#2980b9", textColor: "#fff" };
  if (
    mimeType.includes("spreadsheetml") ||
    mimeType === "application/vnd.ms-excel"
  )
    return { label: "XLS", color: "#27ae60", textColor: "#fff" };
  if (
    mimeType.includes("presentationml") ||
    mimeType === "application/vnd.ms-powerpoint"
  )
    return { label: "PPT", color: "#e67e22", textColor: "#fff" };
  if (mimeType.startsWith("image/"))
    return { label: "IMG", color: "#8e44ad", textColor: "#fff" };
  if (mimeType === "text/csv")
    return { label: "CSV", color: "#16a085", textColor: "#fff" };
  if (mimeType === "text/plain")
    return { label: "TXT", color: "#7f8c8d", textColor: "#fff" };
  if (mimeType === "application/json")
    return { label: "JSON", color: "#f39c12", textColor: "#fff" };
  if (mimeType.includes("zip"))
    return { label: "ZIP", color: "#95a5a6", textColor: "#fff" };
  return { label: "FILE", color: "#bdc3c7", textColor: "#555" };
}

function fileCardIcon(mimeType: string): React.ReactElement {
  const badge = formatBadge(mimeType);

  // Images get a photo icon instead of a text badge
  if (mimeType.startsWith("image/")) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 4,
        }}
      >
        <svg
          width="30"
          height="30"
          viewBox="0 0 24 24"
          fill="none"
          stroke={badge.color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <circle cx="8.5" cy="8.5" r="1.5" fill={badge.color} stroke="none" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            color: badge.color,
            letterSpacing: "0.5px",
          }}
        >
          {badge.label}
        </span>
      </div>
    );
  }

  // JSON — braces icon
  if (mimeType === "application/json") {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 4,
        }}
      >
        <svg
          width="30"
          height="30"
          viewBox="0 0 24 24"
          fill="none"
          stroke={badge.color}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M8 3H7a2 2 0 00-2 2v5a2 2 0 01-2 2 2 2 0 012 2v5c0 1.1.9 2 2 2h1" />
          <path d="M16 3h1a2 2 0 012 2v5a2 2 0 002 2 2 2 0 00-2 2v5a2 2 0 01-2 2h-1" />
        </svg>
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            color: badge.color,
            letterSpacing: "0.5px",
          }}
        >
          {badge.label}
        </span>
      </div>
    );
  }

  // All document formats — colored rounded badge with format label
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 5,
      }}
    >
      {/* Document base icon */}
      <svg width="36" height="44" viewBox="0 0 36 44" fill="none">
        {/* Page shadow */}
        <path
          d="M4 2h20l8 8v32a2 2 0 01-2 2H4a2 2 0 01-2-2V4a2 2 0 012-2z"
          fill="#f0f2f5"
          stroke="#d1d5db"
          strokeWidth="1"
        />
        {/* Fold corner */}
        <path d="M24 2l8 8h-6a2 2 0 01-2-2V2z" fill="#d1d5db" />
        {/* Format badge */}
        <rect x="4" y="24" width="28" height="14" rx="2" fill={badge.color} />
        <text
          x="18"
          y="34"
          textAnchor="middle"
          fontSize="9"
          fontWeight="700"
          fontFamily="system-ui, -apple-system, sans-serif"
          fill={badge.textColor}
          letterSpacing="0.5"
        >
          {badge.label}
        </text>
      </svg>
    </div>
  );
}

/* ── DeleteConfirmModal ─────────────────────────────────────────── */

function DeleteConfirmModal({
  fileName,
  onConfirm,
  onCancel,
}: {
  fileName: string;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <div className="fa-del-backdrop" onClick={onCancel}>
      <div className="fa-del-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fa-del-icon">
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
            <path d="M10 11v6M14 11v6" />
            <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
          </svg>
        </div>
        <p className="fa-del-title">Delete attachment?</p>
        <p className="fa-del-body">
          <strong>{fileName}</strong> will be permanently removed.
        </p>
        <div className="fa-del-actions">
          <button type="button" className="fa-del-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="fa-del-confirm" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── FileCard ───────────────────────────────────────────────────── */

export function FileCard({
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
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isQuarantined = file.scanStatus === "quarantined";
  const isClean = file.scanStatus === "clean";
  const isPending = file.scanStatus === "pending";
  const isFailed = file.scanStatus === "scan_failed";

  async function triggerDownload(): Promise<void> {
    try {
      const blob = await fetchFileBlob(file.id);
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = file.originalName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(objUrl), 10_000);
    } catch {
      /* swallow */
    }
  }

  function handleView(e: React.MouseEvent): void {
    e.stopPropagation();
    if (!canPreview(file.mimeType)) {
      void triggerDownload();
    } else {
      onPreview(file);
    }
  }

  function handleDownload(e: React.MouseEvent): void {
    e.stopPropagation();
    void triggerDownload();
  }

  const badge = formatBadge(file.mimeType);

  return (
    <>
      <div
        className={`fa-card ${isQuarantined ? "fa-card-blocked" : isPending || isFailed ? "fa-card-pending" : ""}`}
        title={
          isQuarantined ? "File blocked — malware detected" : file.originalName
        }
      >
        {/* Coloured top accent bar driven by format badge colour */}
        <div className="fa-card-bar" style={{ background: badge.color }} />

        {/* Icon area */}
        <div className="fa-card-icon">{fileCardIcon(file.mimeType)}</div>

        {/* Name + meta */}
        <div className="fa-card-meta">
          <span className="fa-card-name">{file.originalName}</span>
          <span className="fa-card-size">
            {isQuarantined
              ? "Blocked"
              : isPending
                ? "Scanning…"
                : isFailed
                  ? "Scan failed"
                  : formatBytes(file.sizeBytes)}
          </span>
        </div>

        {/* Hover action overlay — always rendered so CSS :hover works */}
        <div className="fa-card-actions">
          {isClean && (
            <button
              type="button"
              className="fa-card-btn"
              title={canPreview(file.mimeType) ? "Preview" : "Download"}
              onClick={handleView}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          )}
          {isClean && (
            <button
              type="button"
              className="fa-card-btn"
              title="Download"
              onClick={handleDownload}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
          )}
          {canDelete && onDelete && !isPending && (
            <button
              type="button"
              className="fa-card-btn fa-card-btn-delete"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDelete(true);
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {confirmDelete && onDelete && (
        <DeleteConfirmModal
          fileName={file.originalName}
          onConfirm={() => {
            setConfirmDelete(false);
            onDelete(file.id);
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}

/* ── FileCardRow — horizontal scrollable strip ──────────────────── */

export function FileCardRow({
  files,
  onPreview,
  onDelete,
  canDelete,
}: {
  files: AttachmentFile[];
  onPreview: (file: AttachmentFile) => void;
  onDelete: (fileId: string) => void;
  canDelete: (file: AttachmentFile) => boolean;
}): React.ReactElement {
  return (
    <div className="fa-card-row">
      {files.map((file) => (
        <FileCard
          key={file.id}
          file={file}
          onPreview={onPreview}
          onDelete={onDelete}
          canDelete={canDelete(file)}
        />
      ))}
    </div>
  );
}

/* ── FileChip (kept for comment composer staged files) ─────────── */

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
        <button
          type="button"
          className="fa-chip-action"
          title="Download"
          onClick={() => {
            void (async () => {
              try {
                const blob = await fetchFileBlob(file.id);
                const objUrl = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = objUrl;
                a.download = file.originalName;
                a.click();
                setTimeout(() => URL.revokeObjectURL(objUrl), 10_000);
              } catch {
                /* swallow */
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
        </button>
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
    // A property on a ref object (rather than a bare `let`) so TS doesn't
    // narrow it to a stale literal across the `await` boundaries below —
    // it's genuinely mutated by the cleanup function after those awaits.
    const state = { cancelled: false };
    let objUrl: string | undefined;
    async function load(): Promise<void> {
      try {
        const blob = await fetchFileBlob(file.id, true);
        if (state.cancelled) return;
        objUrl = URL.createObjectURL(blob);
        setDownloadUrl(objUrl);

        if (isText) {
          const text = await blob.text();
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- TS narrows `state.cancelled` to a stale literal here; the cleanup function genuinely flips it after this await resolves.
          if (state.cancelled) return;
          setTextContent(text.slice(0, 50_000));
        }
      } catch (err) {
        if (!state.cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load file");
        }
      } finally {
        if (!state.cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      state.cancelled = true;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [file.id, isText]);

  return (
    <div className="fa-modal-backdrop" onClick={onClose}>
      <div className="fa-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fa-modal-header">
          <span className="fa-modal-title">{file.originalName}</span>
          <span className="fa-modal-size">{formatBytes(file.sizeBytes)}</span>
          {downloadUrl && (
            <button
              type="button"
              className="fa-modal-download"
              title="Download"
              onClick={() => {
                // downloadUrl is already a blob: object URL from the effect
                // above — no need to re-fetch, just trigger a save-as.
                const a = document.createElement("a");
                a.href = downloadUrl;
                a.download = file.originalName;
                a.click();
              }}
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
            </button>
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
              {!isImage && !isPdf && !isText && (
                <div className="fa-modal-no-preview">
                  <svg
                    width="40"
                    height="40"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ opacity: 0.35 }}
                  >
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <p>No preview available for this file type.</p>
                  <p style={{ fontSize: "12px", opacity: 0.6 }}>
                    Use the download button above to open it.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
