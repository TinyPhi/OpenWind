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
    // to the upload hook's own cleanFileIds changing, not fire on every
    // parent re-render.
  }, [cleanFileIds]);

  function handleRemoveExisting(fileId: string): void {
    const remaining = currentIds.filter((id) => id !== fileId);
    onChange(multiple ? remaining : null);
  }

  const canAddMore = multiple || currentIds.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {existingFiles.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
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
      {stagedFiles.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {stagedFiles.map((f) => (
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
