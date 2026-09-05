// __accessUsers is internal ACL bookkeeping (per-user access grants/mentions)
// stored in the same `fields` JSONB column as real entity fields, purely
// because that's where entity-engine's access-grant mechanism happens to
// write it -- it was never meant to be a caller-visible field. Found leaking
// through both GET /tickets/:id and GET /workflows/:id/tickets (which
// return the raw `fields` object as-is, sensitivity-redacted but otherwise
// unfiltered): a third-party caller could see the full set of internal
// platform user IDs granted access to a ticket, plus their grant levels --
// information about who else can see this ticket, not the ticket's own
// data. Stripped here, applied at every third-party route that returns a
// ticket's fields, independent of and in addition to pii/financial
// redaction (redact-entity-fields.ts) -- __accessUsers itself is never
// tagged with a sensitivity level, so redaction alone would never catch it.
const INTERNAL_FIELD_KEYS = ["__accessUsers"] as const;

export function stripInternalFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  if (!INTERNAL_FIELD_KEYS.some((key) => key in fields)) return fields;
  const copy = { ...fields };
  for (const key of INTERNAL_FIELD_KEYS) {
    delete copy[key];
  }
  return copy;
}
