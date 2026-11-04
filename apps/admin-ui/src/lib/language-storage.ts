const STORAGE_KEY = "ow:language";

export const SUPPORTED_LANGUAGES = [
  "en",
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
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * Languages that have completed translations.
 * Untranslated locales remain in SUPPORTED_LANGUAGES for key completeness tests
 * but are disabled in the UI until translations are ready (#1110).
 */
export const TRANSLATED_LANGUAGES = [
  "en",
] as const satisfies readonly SupportedLanguage[];

export type TranslatedLanguage = (typeof TRANSLATED_LANGUAGES)[number];

export function isTranslatedLanguage(lng: string): lng is TranslatedLanguage {
  // Cast needed to test arbitrary runtime strings against the literal array
  return (TRANSLATED_LANGUAGES as readonly string[]).includes(lng);
}

export function getSavedLanguage(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isTranslatedLanguage(stored)) {
      return stored;
    }
  } catch {
    // localStorage unavailable (private browsing, etc.)
  }
  return "en";
}

export function setSavedLanguage(lng: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    // localStorage unavailable — preference won't persist
  }
}
