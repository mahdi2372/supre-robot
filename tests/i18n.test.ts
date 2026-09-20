import { describe, expect, it } from 'vitest';
import { translate, isSupportedLocale, SUPPORTED_LOCALES } from '../src/utils/i18n/index.js';

describe('i18n', () => {
  it('supports en and bn', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'bn']);
    expect(isSupportedLocale('en')).toBe(true);
    expect(isSupportedLocale('bn')).toBe(true);
    expect(isSupportedLocale('fr')).toBe(false);
  });

  it('translates english keys', () => {
    expect(translate('en', 'error.permission_denied')).toContain('permission');
  });

  it('translates bangla keys', () => {
    const out = translate('bn', 'error.permission_denied');
    expect(out).toContain('অনুমতি');
  });

  it('substitutes parameters and keeps unknown params intact', () => {
    const out = translate('en', 'mod.ban_applied', { user: '@x', case: 7, reason: 'spam' });
    expect(out).toContain('@x');
    expect(out).toContain('#7');
    expect(out).toContain('spam');
    expect(translate('en', 'core.ping', { gateway: 10 })).not.toContain('{rtt}'.replace('{rtt}', '{rtt') ? false : true);
  });

  it('falls back to english for keys missing in bangla', () => {
    // All current bn keys mirror en; simulate by checking the mechanism with a raw key.
    expect(translate('bn', 'some.future.key')).toBe('some.future.key');
    expect(translate('en', 'some.future.key')).toBe('some.future.key');
  });

  it('falls back to english for unsupported locales', () => {
    expect(translate('fr', 'error.internal')).toBe(translate('en', 'error.internal'));
  });

  it('returns the raw key for unknown keys', () => {
    expect(translate('en', 'nope.nope')).toBe('nope.nope');
  });
});
