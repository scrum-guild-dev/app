import { describe, expect, it } from 'vitest';
import { formatMonthDay } from './format-datetime.ts';

describe('formatMonthDay', () => {
  it('YYYY-MM-DD を月/日で出し、0 埋めしない', () => {
    expect(formatMonthDay('2026-10-19')).toBe('10/19');
    expect(formatMonthDay('2026-01-05')).toBe('1/5');
  });
  it('読めない値は受け取った文字列のまま返す', () => {
    expect(formatMonthDay('10/19')).toBe('10/19');
    expect(formatMonthDay('')).toBe('');
  });
});
