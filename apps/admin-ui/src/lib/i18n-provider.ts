import type { I18nProvider } from "@refinedev/core";
import { changeLocale } from "./language.js";

export function createI18nProvider(
  translateFn: (key: string, params?: Record<string, unknown>) => string,
  getLocaleFn: () => string,
  changeLocaleFn: (lng: string) => Promise<void> = changeLocale,
): I18nProvider {
  return {
    translate: (key: string, params?: object) =>
      translateFn(key, params as Record<string, unknown>),
    changeLocale: changeLocaleFn,
    getLocale: getLocaleFn,
  };
}
