import { normalizeEmail } from '../shared/email.ts';
import { safeReturnTo } from '../shared/return-to.ts';

export function setupReturnTo(value: unknown): string {
  const path = safeReturnTo(value);
  try {
    const decoded = decodeURIComponent(new URL(path, 'https://setup.invalid').pathname).toLowerCase();
    return decoded.replace(/\/+$/, '') === '/auth/setup' ? '/' : path;
  } catch {
    return '/';
  }
}

export function invitationEmails(value: string): string[] | null {
  const entries = value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0 || entries.length > 20) return null;
  const normalized = entries.map(normalizeEmail);
  if (normalized.some((entry) => entry === undefined)) return null;
  return [...new Set(normalized as string[])];
}
