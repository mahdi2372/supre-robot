import en from '../../locales/en.js';
import bn from '../../locales/bn.js';
import { isSupportedLocale, SUPPORTED_LOCALES } from './types.js';
import type { Locale } from './types.js';

/**
 * Internationalization.
 *
 * Adding a language: create src/locales/<code>.ts exporting a
 * Record<string,string>, import + register it in CATALOGS below, and add
 * its code to SUPPORTED_LOCALES in ./types.ts. Missing keys fall back to
 * English, then to the raw key — a partial locale can never crash the bot.
 */

const CATALOGS: Record<Locale, Record<string, string>> = { en, bn };

export type { Locale, TranslateFn } from './types.js';
export { SUPPORTED_LOCALES, isSupportedLocale };

export function translate(
  locale: string,
  key: string,
  params: Record<string, string | number> = {}
): string {
  const loc: Locale = isSupportedLocale(locale) ? locale : 'en';
  const template = CATALOGS[loc][key] ?? CATALOGS.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
