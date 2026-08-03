import React, { useEffect, useState } from "react";
import { fetchWithAuth, API_URL } from "../lib/api.js";
import { useFileUpload } from "../hooks/use-file-upload.js";
import {
  AttachmentUploadZone,
  StagedFileChip,
  FileChip,
  FilePreviewModal,
  type AttachmentFile,
} from "./file-attachment.js";

/**
 * Widget for `file`/`files` fields (#289). `useFileUpload` calls hooks
 * internally, so it must live in its own component mounted from FieldInput's
 * switch — never inline in a switch case — same reason UserRefPicker/
 * EntityRefPicker are separate components rather than branches.
 *
 * "Remove" here only clears this field's own reference (via onChange); it
 * never deletes the underlying file, since it may still legitimately appear
 * in the entity's general attachments list.
 */

export interface FileFieldPickerProps {
  value: string | string[] | null;
  onChange: (v: string | string[] | null) => void;
  multiple: boolean;
  moduleSlug: string;
  entityId: string | undefined;
}

function idsFromValue(value: string | string[] | null): string[] {
  if (value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function FileFieldPicker({
  value,
  onChange,
  multiple,
  moduleSlug,
  entityId,
}: FileFieldPickerProps): React.ReactElement {
  const { stagedFiles, addFiles, removeFile, cleanFileIds } = useFileUpload({
    ...(entityId !== undefined ? { entityId } : {}),
    moduleSlug,
  });
  const [existingFiles, setExistingFiles] = useState<AttachmentFile[]>([]);
  const [previewFile, setPreviewFile] = useState<AttachmentFile | null>(null);
  const currentIds = idsFromValue(value);

  useEffect(() => {
    if (!entityId || currentIds.length === 0) {
      setExistingFiles([]);
      return;
    }
    let cancelled = false;
    void fetchWithAuth(`${API_URL}/entities/${entityId}/attachments`)
      .then((res) => {
        if (cancelled) return;
        // fetchWithAuth returns unknown; this endpoint's shape is fixed.
        const all = (res as { data: AttachmentFile[] }).data;
        setExistingFiles(all.filter((f) => currentIds.includes(f.id)));
      })
      .catch(() => {
        if (!cancelled) setExistingFiles([]);
      });
    return () => {
      cancelled = true;
    };
    // Deliberately depends on the joined id string, not currentIds itself —
    // re-fetch only when the entity or the set of referenced ids changes,
    // not on every currentIds array identity change.
  }, [entityId, currentIds.join(",")]);

  useEffect(() => {
    if (cleanFileIds.length === 0) return;
    const newIds = cleanFileIds.filter((id) => !currentIds.includes(id));
    if (newIds.length === 0) return;
    if (multiple) {
      onChange([...currentIds, ...newIds]);
    } else {
      onChange(newIds[newIds.length - 1] ?? null);
    }
    // onChange/currentIds are intentionally excluded — this should only react
    // to the upload hook's own cleanFileIds set actually changing, not fire
    // on every parent re-render (cleanFileIds is a fresh array reference each
    // render, same reasoning as the attachment-fetch effect above).
  }, [cleanFileIds.join(",")]);

  function handleRemoveExisting(fileId: string): void {
    const remaining = currentIds.filter((id) => id !== fileId);
    onChange(multiple ? remaining : null);
  }

  // Once a staged file's id shows up in existingFiles (POST /files already
  // associated it via entityId, and the attachment-fetch effect above picked
  // it up), stop rendering its StagedFileChip — otherwise both chips render
  // for the same file.
  const visibleStagedFiles = stagedFiles.filter(
    (f) => !existingFiles.some((e) => e.id === f.fileId),
  );

  // In single mode, block a second upload from starting while the first is
  // still mid-scan (currentIds stays empty until the effect above fires) —
  // otherwise two files reaching "clean" simultaneously could leave the
  // first stranded in stagedFiles as a visual orphan.
  const canAddMore =
    multiple || (currentIds.length === 0 && stagedFiles.length === 0);

  return (
    <div className="ffp-container">
      {existingFiles.length > 0 && (
        <div className="ffp-chip-row">
          {existingFiles.map((f) => (
            <FileChip
              key={f.id}
              file={f}
              onPreview={setPreviewFile}
              onDelete={handleRemoveExisting}
              canDelete
            />
          ))}
        </div>
      )}
      {visibleStagedFiles.length > 0 && (
        <div className="ffp-chip-row">
          {visibleStagedFiles.map((f) => (
            <StagedFileChip key={f.fileId} file={f} onRemove={removeFile} />
          ))}
        </div>
      )}
      {canAddMore && (
        <AttachmentUploadZone
          onFiles={(files) => addFiles(multiple ? files : files.slice(0, 1))}
        />
      )}
      {previewFile && (
        <FilePreviewModal
          file={previewFile}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  );
}
