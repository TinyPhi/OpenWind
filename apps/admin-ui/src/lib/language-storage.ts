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

export function getSavedLanguage(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && (SUPPORTED_LANGUAGES as readonly string[]).includes(stored)) {
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
