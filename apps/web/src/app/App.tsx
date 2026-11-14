import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Route, Routes } from 'react-router';
import { SetupPage } from '../features/setup/index.js';
import { PUBLIC_CONFIG_QUERY } from '../shared/api-client.js';
import { LanguageSwitcher } from './LanguageSwitcher.js';

/** Owns application chrome and document metadata independently of feature content. */
export function App() {
  const { t, i18n } = useTranslation('common');
  const config = useQuery(PUBLIC_CONFIG_QUERY);
  const name = config.data?.name ?? t('app.title');
  const language = i18n.resolvedLanguage === 'zh' ? 'zh-CN' : 'en';

  useEffect(() => {
    // Assistive technology and browser metadata must follow the selected UI language.
    document.documentElement.lang = language;
    document.title = name;
  }, [language, name]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label={t('app.home', { name })}>
          <span className="brand-mark" aria-hidden="true">
            a
          </span>
          <span className="brand-name">{name}</span>
        </a>
        <div className="header-actions">
          <span className="edition">{t('app.edition')}</span>
          <LanguageSwitcher />
        </div>
      </header>
      <Routes>
        <Route path="/" element={<SetupPage />} />
      </Routes>
      <footer className="app-footer">
        {name}
        <span>{t('app.footer')}</span>
      </footer>
    </div>
  );
}
