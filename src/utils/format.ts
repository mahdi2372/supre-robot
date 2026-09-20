/** Small locale-aware formatting helpers shared by modules. */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

const PLURAL: Record<string, Record<string, [string, string]>> = {
  en: {
    day: ['day', 'days'],
    hour: ['hour', 'hours'],
    minute: ['minute', 'minutes'],
    member: ['member', 'members'],
    second: ['second', 'seconds']
  },
  bn: {
    day: ['দিন', 'দিন'],
    hour: ['ঘণ্টা', 'ঘণ্টা'],
    minute: ['মিনিট', 'মিনিট'],
    member: ['সদস্য', 'সদস্য'],
    second: ['সেকেন্ড', 'সেকেন্ড']
  }
};

function pluralize(locale: string, unit: string, n: number): string {
  const pair = PLURAL[locale]?.[unit] ?? PLURAL.en?.[unit] ?? [unit, unit];
  return n === 1 ? pair[0]! : pair[1]!;
}

/** "3 days, 4 hours" style duration from milliseconds. */
export function formatDuration(ms: number, locale = 'en'): string {
  if (ms <= 0) return locale === 'bn' ? '0 মিনিট' : '0 minutes';
  const parts: string[] = [];
  const totalMinutes = Math.floor(ms / MIN_MS);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) parts.push(`${days} ${pluralize(locale, 'day', days)}`);
  if (hours > 0) parts.push(`${hours} ${pluralize(locale, 'hour', hours)}`);
  if (minutes > 0 && days === 0) parts.push(`${minutes} ${pluralize(locale, 'minute', minutes)}`);
  if (parts.length === 0) {
    const seconds = Math.max(1, Math.floor(ms / 1000));
    parts.push(`${seconds} ${pluralize(locale, 'second', seconds)}`);
  }
  return parts.join(', ');
}

/** Account age from a Discord user creation timestamp. */
export function formatAccountAge(createdAt: Date | string, locale = 'en'): string {
  const created = typeof createdAt === 'string' ? new Date(createdAt) : createdAt;
  const ageMs = Date.now() - created.getTime();
  const days = Math.floor(ageMs / DAY_MS);
  const hours = Math.floor((ageMs % DAY_MS) / HOUR_MS);
  if (days > 0) return `${days} ${pluralize(locale, 'day', days)}`;
  if (hours > 0) return `${hours} ${pluralize(locale, 'hour', hours)}`;
  return locale === 'bn' ? 'কিছুক্ষণের' : 'a few minutes';
}

export function truncate(text: string, max = 1000): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Compact number for member counts (en: 12.3k). */
export function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
