import { createInstance, type i18n } from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import { SETUP_EN, SETUP_ZH } from '../features/setup/index.js';
import COMMON_EN from './locales/en.json' with { type: 'json' };
import COMMON_ZH from './locales/zh.json' with { type: 'json' };

/** Supported UI languages; regional browser preferences resolve to these base codes. */
export const SUPPORTED_LANGUAGES = ['en', 'zh'] as const;
/** Language identifiers accepted by the UI selector. */
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
/** Shared application strings use this namespace unless a feature selects its own. */
export const DEFAULT_NAMESPACE = 'common';
/** Translation bundles assembled at the application root, with matching namespace shapes. */
export const TRANSLATION_RESOURCES = {
  en: { common: COMMON_EN, setup: SETUP_EN },
  zh: { common: COMMON_ZH, setup: SETUP_ZH },
} satisfies Record<Language, { common: typeof COMMON_EN; setup: typeof SETUP_EN }>;

/** Creates an app-owned instance before rendering, with browser detection and persisted preference. */
export async function initializeI18n(): Promise<i18n> {
  const instance = createInstance();
  // A saved choice wins over navigator preferences; unsupported values fall back to English.
  await instance
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources: TRANSLATION_RESOURCES,
      supportedLngs: [...SUPPORTED_LANGUAGES],
      fallbackLng: 'en',
      load: 'languageOnly',
      defaultNS: DEFAULT_NAMESPACE,
      ns: ['common', 'setup'],
      returnNull: false,
      interpolation: { escapeValue: false },
      detection: {
        order: ['localStorage', 'navigator'],
        caches: ['localStorage'],
        lookupLocalStorage: 'always-on.language',
      },
      react: { useSuspense: false },
    });

  return instance;
}

/** Narrows browser form values to a supported language without assertions. */
export function isSupportedLanguage(language: string): language is Language {
  return SUPPORTED_LANGUAGES.some((supported) => supported === language);
}
