import { arrayMove } from "@dnd-kit/sortable";

export interface OrderableField {
  id: string;
  isSystem: boolean;
  sortOrder: number;
}

/**
 * Moves `activeId` to `overId`'s place and renumbers the fields. System fields (every
 * workflow's title) are protected -- the API refuses any change to them, sort order
 * included -- so they stay pinned first with their sort order untouched, and only the
 * others are renumbered after them (docs/specs/mandatory-ticket-fields.md R1). Returns
 * null when either id isn't a movable field.
 */
export function reorderFields<T extends OrderableField>(
  fields: T[],
  activeId: string,
  overId: string,
): T[] | null {
  const byOrder = [...fields].sort((a, b) => a.sortOrder - b.sortOrder);
  const pinned = byOrder.filter((f) => f.isSystem);
  const movable = byOrder.filter((f) => !f.isSystem);
  const oldIndex = movable.findIndex((f) => f.id === activeId);
  const newIndex = movable.findIndex((f) => f.id === overId);
  if (oldIndex === -1 || newIndex === -1) return null;
  const base = Math.max(-10, ...pinned.map((f) => f.sortOrder)) + 10;
  return [
    ...pinned,
    ...arrayMove(movable, oldIndex, newIndex).map((f, i) => ({
      ...f,
      sortOrder: base + i * 10,
    })),
  ];
}
