import { type ChangeEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isSupportedLanguage, type Language, SUPPORTED_LANGUAGES } from './i18n.js';

/** Changes the UI language through i18next, which owns detection and preference persistence. */
export function LanguageSwitcher() {
  const { t, i18n } = useTranslation('common');
  const [failure, setFailure] = useState<Error | undefined>();
  const language = i18n.resolvedLanguage ?? 'en';

  return (
    <div className="language-control">
      <select aria-label={t('language.label')} value={language} onChange={handleChange}>
        {SUPPORTED_LANGUAGES.map((supported) => (
          <option key={supported} value={supported}>
            {t(`language.${supported}`)}
          </option>
        ))}
      </select>
      {failure ? (
        <p className="language-error" role="alert">
          {t('language.failed')}
        </p>
      ) : null}
    </div>
  );

  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    const selected = event.currentTarget.value;
    if (!isSupportedLanguage(selected)) return;

    void changeLanguage(selected);
  }

  async function changeLanguage(language: Language) {
    setFailure(undefined);

    try {
      await i18n.changeLanguage(language);
    } catch (error) {
      // Keep the original failure while presenting a translated, stable message to the user.
      setFailure(
        error instanceof Error ? error : new Error('Language change failed', { cause: error }),
      );
    }
  }
}
