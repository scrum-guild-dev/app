import { describe, expect, test } from 'vitest';
import { invitationEmails, setupReturnTo } from './onboarding.ts';

describe('導入フローの入力', () => {
  test('宛先を正規化・重複除去し、不正・空・大量の入力を断る', () => {
    expect(invitationEmails(' YUI@example.com,ren@example.com\nyui@example.com ')).toEqual([
      'yui@example.com',
      'ren@example.com',
    ]);
    for (const value of [
      '',
      ',\n',
      'no-at',
      '日本@example.com',
      'a@b c',
      Array.from({ length: 21 }, (_, i) => `${i}@example.com`).join(','),
    ])
      expect(invitationEmails(value)).toBeNull();
    expect(invitationEmails(Array.from({ length: 20 }, (_, i) => `${i}@example.com`).join(','))).toHaveLength(20);
  });
  test('外部やログインへの戻り先と導入画面の再帰を断る', () => {
    for (const value of [
      'https://evil.example',
      '//evil.example',
      '/login',
      '/signup',
      '/api/x',
      '/auth/setup',
      '/auth/setup?return_to=x',
      '/auth/setup/',
      '/%61uth/setup',
      '/auth%2Fsetup',
      null,
    ])
      expect(setupReturnTo(value)).toBe('/');
    expect(setupReturnTo('/aoba/w/123?tab=1')).toBe('/aoba/w/123?tab=1');
  });
});
