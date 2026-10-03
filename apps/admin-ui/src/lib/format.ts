// Some workflow seeds store the machine slug (e.g. "sales_pipeline_workflow")
// as `workflows.name` directly — there's no separate display label. Humanize
// it for presentation rather than showing the raw identifier.
export function humanizeWorkflowName(name: string): string {
  if (!/[_-]/.test(name)) return name;
  return name
    .replace(/[_-]+/g, " ")
    .replace(/\bworkflow\b/gi, "")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function toWorkflowSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function singularize(plural: string): string {
  if (/[a-z]ies$/.test(plural)) return plural.replace(/ies$/, "y");
  if (/s$/i.test(plural)) return plural.replace(/s$/i, "");
  return plural;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export interface AttachmentLike {
  id: string;
  originalName?: string;
}

export function formatFieldValue(
  value: unknown,
  fieldType?: string,
  attachments?: AttachmentLike[],
): string {
  if (value === null || value === undefined) return "—";
  if (fieldType === "file" || fieldType === "files") {
    const ids = Array.isArray(value) ? value : [value];
    const names = ids
      .filter((v): v is string => typeof v === "string")
      .map(
        (fid) => attachments?.find((a) => a.id === fid)?.originalName ?? fid,
      );
    return names.length > 0 ? names.join(", ") : "—";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("amount" in obj && "currency" in obj)
      return `${String(obj.currency)} ${String(obj.amount)}`;
    return JSON.stringify(value);
  }
  return String(value);
}
