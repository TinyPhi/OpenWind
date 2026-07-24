export const DEFAULT_CARD_ICON = "📋";

// `entity_types.icon` is sometimes a lucide-style kebab-case icon name (e.g.
// "trending-up") rather than an emoji glyph — there's no icon component
// wired up to render those, so treat those as absent rather than printing
// the raw identifier as plain text.
export function isRenderableIcon(icon: string | null | undefined): boolean {
  if (!icon) return false;
  const isLikelyIconName = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(icon);
  return !isLikelyIconName;
}

export function resolveCardIcon(icon: string | null | undefined): string {
  return isRenderableIcon(icon) ? (icon as string) : DEFAULT_CARD_ICON;
}
