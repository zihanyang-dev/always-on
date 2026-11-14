import { createInstance } from 'i18next';
import { expect, it } from 'vitest';
import { TRANSLATION_RESOURCES } from './i18n.js';

it('ships the same nonempty translation keys in both languages', () => {
  const english = getMessageKeys(TRANSLATION_RESOURCES.en);
  const chinese = getMessageKeys(TRANSLATION_RESOURCES.zh);
  expect(chinese).toEqual(english);
});

it('resolves regional preferences, interpolates names, and falls back to English', async () => {
  const instance = createInstance();
  await instance.init({
    resources: TRANSLATION_RESOURCES,
    supportedLngs: ['en', 'zh'],
    fallbackLng: 'en',
    load: 'languageOnly',
    lng: 'zh-CN',
  });
  expect(instance.t('common:app.home', { name: 'Workspace' })).toBe('Workspace 首页');
  await instance.changeLanguage('fr-FR');
  expect(instance.t('setup:connection.state.ready')).toBe('Connections ready');
});

function getMessageKeys(messages: unknown, prefix = ''): string[] {
  if (typeof messages === 'string') {
    expect(messages.trim().length, prefix).toBeGreaterThan(0);
    return [prefix];
  }
  if (!messages || typeof messages !== 'object')
    throw new Error(`Invalid translation at ${prefix}`);
  return Object.entries(messages).flatMap(([key, value]) =>
    getMessageKeys(value, prefix ? `${prefix}.${key}` : key),
  );
}
