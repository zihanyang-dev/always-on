import type { DEFAULT_NAMESPACE, TRANSLATION_RESOURCES } from './i18n.js';

declare module 'i18next' {
  /** Keep translation keys and namespaces checked against the actual English resources. */
  interface CustomTypeOptions {
    defaultNS: typeof DEFAULT_NAMESPACE;
    resources: (typeof TRANSLATION_RESOURCES)['en'];
    returnNull: false;
    strictKeyChecks: true;
  }
}
