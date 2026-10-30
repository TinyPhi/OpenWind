import { describe, it, expect } from "vitest";

const SUPPORTED_NON_ENGLISH = [
  "hi",
  "mr",
  "bn",
  "ta",
  "te",
  "kn",
  "fr",
  "de",
  "it",
  "es",
];

// Vite eager glob — bundles all locale JSON files at test time, no Node fs needed.
const localeModules = import.meta.glob<Record<string, unknown>>(
  "./**/common.json",
  {
    eager: true,
  },
);

function getLocale(lng: string): Record<string, unknown> {
  const key = `./${lng}/common.json`;
  const mod = localeModules[key];
  if (!mod) throw new Error(`Locale file not found: ${key}`);
  return mod;
}

function collectKeys(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null) return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    collectKeys(v, prefix ? `${prefix}.${k}` : k),
  );
}

const englishKeys = collectKeys(getLocale("en")).sort();

describe("locale completeness", () => {
  for (const lng of SUPPORTED_NON_ENGLISH) {
    it(`${lng}/common.json has the same keys as en/common.json`, () => {
      const keys = collectKeys(getLocale(lng)).sort();
      expect(keys).toEqual(englishKeys);
    });
  }
});
