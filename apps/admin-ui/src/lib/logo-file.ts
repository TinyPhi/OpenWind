/** Mirrors the server's limits for a sandbox logo (apps/api/src/lib/sandbox-logo.ts, R12). */
export const MAX_LOGO_BYTES = 100 * 1024;
export const LOGO_ACCEPT = "image/png,image/jpeg,image/webp";
const ACCEPTED_TYPES = new Set(LOGO_ACCEPT.split(","));

/** Returns why a file can't be used as a logo, or null when it can. */
export function checkLogoFile(file: {
  type: string;
  size: number;
}): string | null {
  if (!ACCEPTED_TYPES.has(file.type)) {
    return "Logo must be a PNG, JPEG or WebP image.";
  }
  if (file.size > MAX_LOGO_BYTES) {
    return "Logo must be 100 KB or smaller.";
  }
  return null;
}

export function readLogoFile(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read the image"));
    };
    reader.onerror = () => reject(new Error("Could not read the image"));
    reader.readAsDataURL(file);
  });
}
