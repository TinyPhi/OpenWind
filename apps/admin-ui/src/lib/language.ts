import { useState, useEffect } from "react";
import { i18n } from "../i18n.js";

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

const STORAGE_KEY = "ow:language";

export function getSavedLanguage(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && (SUPPORTED_LANGUAGES as readonly string[]).includes(stored)) {
      return stored;
    }
  } catch {
    // localStorage unavailable (private browsing, etc.) — fall through to default
  }
  return "en";
}

export function setSavedLanguage(lng: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    // localStorage unavailable — preference simply won't persist
  }
}

export async function changeLocale(lng: string): Promise<void> {
  const validated = (SUPPORTED_LANGUAGES as readonly string[]).includes(lng)
    ? lng
    : "en";
  await i18n.changeLanguage(validated);
  setSavedLanguage(validated);
  document.documentElement.lang = validated;
}

export function useLocale(): {
  locale: string;
  changeLocale: (lng: string) => Promise<void>;
} {
  const [locale, setLocale] = useState(
    () => i18n.language || getSavedLanguage(),
  );

  useEffect(() => {
    function onLanguageChanged(lng: string): void {
      setLocale(lng);
    }
    i18n.on("languageChanged", onLanguageChanged);
    return () => {
      i18n.off("languageChanged", onLanguageChanged);
    };
  }, []);

  return { locale, changeLocale };
}
