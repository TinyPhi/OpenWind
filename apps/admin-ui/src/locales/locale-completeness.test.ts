import { describe, it, expect } from "vitest";
import { TRANSLATED_LANGUAGES, isTranslatedLanguage } from "../lib/language.js";

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

function collectKeyValuePairs(obj: unknown, prefix = ""): Map<string, string> {
  const map = new Map<string, string>();
  if (typeof obj !== "object" || obj === null) {
    map.set(prefix, String(obj));
    return map;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "object" && v !== null) {
      for (const [subKey, subVal] of collectKeyValuePairs(v, fullKey)) {
        map.set(subKey, subVal);
      }
    } else {
      map.set(fullKey, String(v));
    }
  }
  return map;
}

function getTranslatedRatio(
  targetLocale: Record<string, unknown>,
  enLocale: Record<string, unknown>,
): { differing: number; total: number; ratio: number } {
  const targetMap = collectKeyValuePairs(targetLocale);
  const enMap = collectKeyValuePairs(enLocale);
  let total = 0;
  let differing = 0;
  for (const [key, enVal] of enMap.entries()) {
    total++;
    const targetVal = targetMap.get(key);
    if (targetVal !== undefined && targetVal !== enVal) {
      differing++;
    }
  }
  return { differing, total, ratio: total > 0 ? differing / total : 0 };
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

describe("untranslated stub locales have negligible differing keys from English", () => {
  const untranslatedStubs = SUPPORTED_NON_ENGLISH.filter(
    (lng) => !isTranslatedLanguage(lng),
  );
  for (const lng of untranslatedStubs) {
    it(`${lng}/common.json is a stub (less than 5% differing values from English)`, () => {
      const { total, ratio } = getTranslatedRatio(
        getLocale(lng),
        getLocale("en"),
      );
      expect(total).toBeGreaterThan(0);
      expect(ratio).toBeLessThan(0.05);
    });
  }
});

describe("enabled translated locales meet minimum translation threshold", () => {
  const enabledNonEnglish = (TRANSLATED_LANGUAGES as readonly string[]).filter(
    (l) => l !== "en",
  );
  if (enabledNonEnglish.length === 0) {
    it("currently only en is enabled in TRANSLATED_LANGUAGES", () => {
      expect(TRANSLATED_LANGUAGES).toEqual(["en"]);
    });
  }
  for (const lng of enabledNonEnglish) {
    it(`${lng}/common.json has at least 80% non-English values`, () => {
      const { ratio } = getTranslatedRatio(getLocale(lng), getLocale("en"));
      expect(ratio).toBeGreaterThanOrEqual(0.8);
    });
  }

  it("translation threshold calculation accurately detects stubs vs translated content", () => {
    const en = getLocale("en");
    // English compared to English has 0% differing ratio
    expect(getTranslatedRatio(en, en).ratio).toBe(0);

    // Stubs have less than 5% differing values
    const hi = getLocale("hi");
    expect(getTranslatedRatio(hi, en).ratio).toBeLessThan(0.05);

    // A fully translated dictionary has >= 80% differing values
    function recursivelyTranslate(obj: unknown): unknown {
      if (typeof obj !== "object" || obj === null) {
        return `[translated] ${String(obj)}`;
      }
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        result[k] = recursivelyTranslate(v);
      }
      return result;
    }
    const simulated = recursivelyTranslate(en) as Record<string, unknown>;
    expect(getTranslatedRatio(simulated, en).ratio).toBeGreaterThanOrEqual(0.8);
  });
});
