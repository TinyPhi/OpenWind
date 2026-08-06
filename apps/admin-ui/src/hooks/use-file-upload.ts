import { useState, useCallback, useEffect, useRef } from "react";
import { fetchWithAuth, API_URL } from "../lib/api.js";
import { userManager, waitForAuth, silentRefresh } from "../authProvider.js";
import { showAlert } from "../components/global-alert-dialog.js";

export type ScanStatus = "pending" | "clean" | "quarantined" | "scan_failed";

export type StagedFile = {
  fileId: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  scanStatus: ScanStatus;
  previewUrl?: string;
  uploadProgress: number;
};

const EXT_MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  zip: "application/zip",
};

const ALLOWED_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/json",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/zip",
  "application/x-zip-compressed",
]);

// Document formats must be at least 1 KB — anything smaller is a cloud
// placeholder stub (OneDrive/SharePoint Files-on-Demand) not the real file.
const DOC_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
  "application/x-zip-compressed",
]);
const MIN_DOC_BYTES = 1024;

function getSizeLimit(mimeType: string): number {
  if (mimeType.startsWith("image/")) return 10 * 1024 * 1024;
  if (mimeType.startsWith("text/") || mimeType === "application/json")
    return 5 * 1024 * 1024;
  if (
    mimeType === "application/zip" ||
    mimeType === "application/x-zip-compressed"
  )
    return 100 * 1024 * 1024;
  return 50 * 1024 * 1024;
}

async function compressImage(
  file: File,
): Promise<{ blob: Blob; mime: string }> {
  if (file.type === "image/gif") return { blob: file, mime: file.type };
  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const MAX_DIM = 2048;
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      if (w > MAX_DIM || h > MAX_DIM) {
        if (w > h) {
          h = Math.round((h * MAX_DIM) / w);
          w = MAX_DIM;
        } else {
          w = Math.round((w * MAX_DIM) / h);
          h = MAX_DIM;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve({ blob: file, mime: file.type });
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (blob) =>
          resolve(
            blob
              ? { blob, mime: "image/jpeg" }
              : { blob: file, mime: file.type },
          ),
        "image/jpeg",
        0.85,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({ blob: file, mime: file.type });
    };
    img.src = objectUrl;
  });
}

type UploadResult = { fileId: string; scanStatus: string };

/**
 * Upload the multipart form via XHR (not fetch) so we get real progress
 * events — fetch has no upload progress API. Retries once on 401 with a
 * refreshed token, mirroring fetchWithAuth's retry behavior.
 */
function xhrUploadMultipart(
  url: string,
  form: FormData,
  token: string | undefined,
  onProgress: (pct: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(
            (JSON.parse(xhr.responseText) as { data: UploadResult }).data,
          );
        } catch {
          reject(new Error("Upload succeeded but response was invalid"));
        }
        return;
      }
      if (xhr.status === 401) {
        void silentRefresh().then((newToken) => {
          if (!newToken) {
            reject(new Error("Session expired"));
            return;
          }
          xhrUploadMultipart(url, form, newToken, onProgress).then(
            resolve,
            reject,
          );
        });
        return;
      }
      let message = `Upload failed: ${xhr.status}`;
      try {
        const body = JSON.parse(xhr.responseText) as {
          message?: string;
          error?: string;
        };
        message = body.message ?? body.error ?? message;
      } catch {
        /* keep default message */
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.open("POST", url);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.send(form);
  });
}

export function useFileUpload({
  entityId,
  moduleSlug,
}: {
  entityId?: string;
  moduleSlug: string;
}): {
  stagedFiles: StagedFile[];
  addFiles: (files: File[]) => Promise<void>;
  removeFile: (fileId: string) => void;
  clearFiles: () => void;
  pendingCount: number;
  cleanFileIds: string[];
} {
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const pollTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  useEffect(() => {
    return () => {
      pollTimers.current.forEach((t) => clearTimeout(t));
      setStagedFiles((prev) => {
        prev.forEach((f) => {
          if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
        });
        return [];
      });
    };
  }, []);

  const updateFile = useCallback(
    (fileId: string, updates: Partial<StagedFile>) => {
      setStagedFiles((prev) =>
        prev.map((f) => (f.fileId === fileId ? { ...f, ...updates } : f)),
      );
    },
    [],
  );

  const schedulePoll = useCallback(
    (fileId: string, delayMs: number) => {
      const check = async (): Promise<void> => {
        try {
          const res = (await fetchWithAuth(
            `${API_URL}/files/${fileId}/status`,
          )) as {
            data: { fileId: string; scanStatus: ScanStatus };
          };
          const status = res.data.scanStatus;
          updateFile(fileId, { scanStatus: status });
          if (status === "pending") {
            const t = setTimeout(check, 3000);
            pollTimers.current.set(fileId, t);
          } else {
            pollTimers.current.delete(fileId);
          }
        } catch {
          const t = setTimeout(check, 5000);
          pollTimers.current.set(fileId, t);
        }
      };
      const t = setTimeout(check, delayMs);
      pollTimers.current.set(fileId, t);
    },
    [updateFile],
  );

  const addFiles = useCallback(
    async (rawFiles: File[]): Promise<void> => {
      for (const file of rawFiles) {
        const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
        const resolvedMime =
          file.type !== "" ? file.type : (EXT_MIME[ext] ?? "");
        if (!ALLOWED_MIMES.has(resolvedMime)) {
          showAlert(`File type not supported: "${file.name}"`);
          continue;
        }
        if (DOC_MIMES.has(resolvedMime) && file.size < MIN_DOC_BYTES) {
          showAlert(
            `"${file.name}" appears to be a cloud placeholder (${file.size} B) that hasn't been downloaded yet.\n\nIn File Explorer, right-click the file → "Always keep on this device", wait for it to download, then try again.`,
          );
          continue;
        }
        const limit = getSizeLimit(resolvedMime);
        if (file.size > limit) {
          showAlert(
            `"${file.name}" exceeds the ${Math.round(limit / 1024 / 1024)} MB limit for this type.`,
          );
          continue;
        }

        // Build preview URL from original file (before compression)
        const previewUrl = resolvedMime.startsWith("image/")
          ? URL.createObjectURL(file)
          : undefined;

        // Compress images
        let uploadBlob: Blob = file;
        let uploadMime = resolvedMime;
        if (resolvedMime.startsWith("image/")) {
          const compressed = await compressImage(file);
          uploadBlob = compressed.blob;
          uploadMime = compressed.mime;
        }

        const tempId = `temp-${crypto.randomUUID()}`;
        const newEntry: StagedFile = {
          fileId: tempId,
          originalName: file.name,
          mimeType: uploadMime,
          sizeBytes: uploadBlob.size,
          scanStatus: "pending",
          uploadProgress: 0,
          ...(previewUrl !== undefined && { previewUrl }),
        };
        setStagedFiles((prev) => [...prev, newEntry]);

        try {
          await waitForAuth();
          const user = await userManager.getUser();

          const form = new FormData();
          form.set("file", uploadBlob, file.name);
          form.set("moduleSlug", moduleSlug);
          if (entityId) form.set("entityId", entityId);

          const result = await xhrUploadMultipart(
            `${API_URL}/files`,
            form,
            user?.access_token,
            (pct) => {
              setStagedFiles((prev) =>
                prev.map((f) =>
                  f.fileId === tempId ? { ...f, uploadProgress: pct } : f,
                ),
              );
            },
          );

          const { fileId } = result;
          setStagedFiles((prev) =>
            prev.map((f) =>
              f.fileId === tempId ? { ...f, fileId, uploadProgress: 100 } : f,
            ),
          );
          schedulePoll(fileId, 2000);
        } catch (err) {
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          setStagedFiles((prev) => prev.filter((f) => f.fileId !== tempId));
          showAlert(
            `Upload failed: ${err instanceof Error ? err.message : "Unknown error"}`,
          );
        }
      }
    },
    [entityId, moduleSlug, schedulePoll],
  );

  const removeFile = useCallback((fileId: string) => {
    const timer = pollTimers.current.get(fileId);
    if (timer) {
      clearTimeout(timer);
      pollTimers.current.delete(fileId);
    }
    setStagedFiles((prev) => {
      const found = prev.find((f) => f.fileId === fileId);
      if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
      return prev.filter((f) => f.fileId !== fileId);
    });
    if (!fileId.startsWith("temp-")) {
      void fetchWithAuth(`${API_URL}/files/${fileId}`, {
        method: "DELETE",
      }).catch(() => {});
    }
  }, []);

  const clearFiles = useCallback(() => {
    pollTimers.current.forEach((t) => clearTimeout(t));
    pollTimers.current.clear();
    setStagedFiles((prev) => {
      prev.forEach((f) => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      });
      return [];
    });
  }, []);

  const pendingCount = stagedFiles.filter(
    (f) => f.scanStatus === "pending",
  ).length;
  const cleanFileIds = stagedFiles
    .filter((f) => f.scanStatus === "clean")
    .map((f) => f.fileId);

  return {
    stagedFiles,
    addFiles,
    removeFile,
    clearFiles,
    pendingCount,
    cleanFileIds,
  };
}
