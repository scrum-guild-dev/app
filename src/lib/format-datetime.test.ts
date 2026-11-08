import { describe, expect, test } from 'vitest';
import { formatTodayLabel } from './format-datetime.ts';

describe('formatTodayLabel', () => {
  test('年月日と曜日を、見本と同じ全角の括弧で出す', () => {
    expect(formatTodayLabel(new Date('2026-10-20T03:00:00Z'), 'Asia/Tokyo')).toBe('2026年10月20日（火）');
  });

  test('渡したタイムゾーンの今日で出す（UTC ではまだ前の日）', () => {
    const now = new Date('2026-10-19T16:00:00Z');
    expect(formatTodayLabel(now, 'Asia/Tokyo')).toBe('2026年10月20日（火）');
    expect(formatTodayLabel(now, 'UTC')).toBe('2026年10月19日（月）');
  });

  test('月と日は0で埋めない', () => {
    expect(formatTodayLabel(new Date('2027-01-05T00:00:00Z'), 'UTC')).toBe('2027年1月5日（火）');
  });
});
