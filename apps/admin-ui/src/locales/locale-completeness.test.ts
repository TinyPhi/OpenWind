import { describe, it, expect } from "vitest";
import { TRANSLATED_LANGUAGES } from "../lib/language.js";

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

describe("translated locales have non-English values", () => {
  const nonEnglish = (TRANSLATED_LANGUAGES as readonly string[]).filter(
    (l) => l !== "en",
  );
  if (nonEnglish.length === 0) {
    it("currently only en is in TRANSLATED_LANGUAGES (#1110 gate)", () => {
      expect(TRANSLATED_LANGUAGES).toEqual(["en"]);
    });
  } else {
    for (const lng of nonEnglish) {
      it(`${lng}/common.json has non-English values for enabled locale`, () => {
        expect(JSON.stringify(getLocale(lng))).not.toEqual(
          JSON.stringify(getLocale("en")),
        );
      });
    }
  }
});
