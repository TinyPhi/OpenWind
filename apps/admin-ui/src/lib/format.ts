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
