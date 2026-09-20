export type Locale = 'en' | 'bn';

export const SUPPORTED_LOCALES: Locale[] = ['en', 'bn'];

export function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export type TranslateFn = (
  locale: string,
  key: string,
  params?: Record<string, string | number>
) => string;
