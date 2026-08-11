export type ThemeMode = "dark" | "light";

export interface AccentColor {
  id: string;
  label: string;
  h: number;
  s: number;
  l: number;
}

export const ACCENT_COLORS: AccentColor[] = [
  { id: "teal", label: "Teal", h: 175, s: 70, l: 44 },
  { id: "purple", label: "Purple", h: 250, s: 84, l: 60 },
  { id: "blue", label: "Blue", h: 213, s: 84, l: 56 },
  { id: "indigo", label: "Indigo", h: 240, s: 80, l: 58 },
  { id: "green", label: "Green", h: 152, s: 70, l: 42 },
  { id: "orange", label: "Orange", h: 30, s: 90, l: 52 },
  { id: "rose", label: "Rose", h: 350, s: 80, l: 58 },
  { id: "pink", label: "Pink", h: 312, s: 78, l: 58 },
];

const STORAGE_THEME = "ow_theme";
const STORAGE_ACCENT = "ow_accent";
const STORAGE_ACCENT_CUSTOM = "ow_accent_custom";
const CUSTOM_ACCENT_ID = "custom";

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const normalized = hex.replace("#", "");
  const r = parseInt(normalized.substring(0, 2), 16) / 255;
  const g = parseInt(normalized.substring(2, 4), 16) / 255;
  const b = parseInt(normalized.substring(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
  }

  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function hslToHex(h: number, s: number, l: number): string {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lNorm - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  const toHex = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function makeCustomAccent(hex: string): AccentColor {
  const { h, s, l } = hexToHsl(hex);
  return { id: CUSTOM_ACCENT_ID, label: "Custom", h, s, l };
}

export function getSavedTheme(): ThemeMode {
  return (localStorage.getItem(STORAGE_THEME) as ThemeMode | null) ?? "dark";
}

export function getSavedAccent(): AccentColor {
  const id = localStorage.getItem(STORAGE_ACCENT);
  if (id === CUSTOM_ACCENT_ID) {
    const hex = localStorage.getItem(STORAGE_ACCENT_CUSTOM);
    if (hex) return makeCustomAccent(hex);
  }
  const found = ACCENT_COLORS.find((c) => c.id === id);
  // ACCENT_COLORS is always non-empty — the fallback cast is safe
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return found ?? ACCENT_COLORS[0]!;
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.setAttribute("data-theme", mode);
  localStorage.setItem(STORAGE_THEME, mode);
}

export function applyAccent(color: AccentColor): void {
  const root = document.documentElement;
  const { h, s, l } = color;
  root.style.setProperty("--accent-h", String(h));
  root.style.setProperty("--accent-s", `${s}%`);
  root.style.setProperty("--accent-l", `${l}%`);
  root.style.setProperty("--accent-primary", `hsl(${h}, ${s}%, ${l}%)`);
  root.style.setProperty(
    "--accent-secondary",
    `hsl(${h + 22}, ${s}%, ${l - 6}%)`,
  );
  root.style.setProperty(
    "--accent-hover",
    `hsl(${h}, ${Math.min(s + 10, 100)}%, ${Math.min(l + 8, 90)}%)`,
  );
  root.style.setProperty("--border-focus", `hsla(${h}, ${s}%, ${l}%, 0.4)`);
  localStorage.setItem(STORAGE_ACCENT, color.id);
  if (color.id === CUSTOM_ACCENT_ID) {
    localStorage.setItem(STORAGE_ACCENT_CUSTOM, hslToHex(h, s, l));
  }
}

export function initTheme(): void {
  applyTheme(getSavedTheme());
  applyAccent(getSavedAccent());
}
