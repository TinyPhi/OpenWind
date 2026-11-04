import { useState, useEffect } from "react";
import { i18n } from "../i18n.js";
import {
  SUPPORTED_LANGUAGES,
  TRANSLATED_LANGUAGES,
  isTranslatedLanguage,
  getSavedLanguage,
  setSavedLanguage,
  type SupportedLanguage,
  type TranslatedLanguage,
} from "./language-storage.js";

export {
  SUPPORTED_LANGUAGES,
  TRANSLATED_LANGUAGES,
  isTranslatedLanguage,
  getSavedLanguage,
  setSavedLanguage,
};
export type { SupportedLanguage, TranslatedLanguage };

export async function changeLocale(lng: string): Promise<void> {
  const validated = isTranslatedLanguage(lng) ? lng : "en";
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
