import { arrayMove } from "@dnd-kit/sortable";

export interface OrderableField {
  id: string;
  isSystem: boolean;
  sortOrder: number;
}

// System fields are pinned first; their sort order is never touched (API rejects changes).
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
