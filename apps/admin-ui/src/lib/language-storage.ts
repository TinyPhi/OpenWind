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
export const TRANSLATED_LANGUAGES: readonly SupportedLanguage[] = [
  "en",
] as const;

export function getSavedLanguage(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (
      stored &&
      (TRANSLATED_LANGUAGES as readonly string[]).includes(stored)
    ) {
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
