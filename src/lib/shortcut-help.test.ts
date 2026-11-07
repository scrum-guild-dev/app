import { describe, expect, test } from 'vitest';
import { shortcutHelpGroups } from './shortcut-help.ts';
import type { Shortcut } from './shortcuts.svelte.ts';

const shortcut = (id: string, extra: Partial<Shortcut> = {}): Shortcut => ({
  id,
  keys: 'c',
  label: () => id,
  run: () => {},
  ...extra,
});

describe('shortcutHelpGroups', () => {
  test('global を付けたものを「どの画面でも」に、それ以外を「この画面」に、登録の順で分ける', () => {
    const groups = shortcutHelpGroups([
      shortcut('search', { global: true }),
      shortcut('new-task'),
      shortcut('go-sprint', { global: true }),
      shortcut('drawer-prev'),
    ]);
    expect(groups.screen.map((item) => item.id)).toEqual(['new-task', 'drawer-prev']);
    expect(groups.global.map((item) => item.id)).toEqual(['search', 'go-sprint']);
  });

  test('enabled が false のものは出さず、true と未指定は出す', () => {
    const groups = shortcutHelpGroups([
      shortcut('off', { enabled: () => false }),
      shortcut('on', { enabled: () => true }),
      shortcut('none'),
      shortcut('go-here', { global: true, enabled: () => false }),
    ]);
    expect(groups.screen.map((item) => item.id)).toEqual(['on', 'none']);
    expect(groups.global).toEqual([]);
  });

  test('組の中は helpOrder の小さい順で、同じ値は登録順', () => {
    const groups = shortcutHelpGroups([
      shortcut('help', { global: true, helpOrder: 9 }),
      shortcut('go-backlog', { global: true, helpOrder: 2 }),
      shortcut('go-sprint', { global: true, helpOrder: 2 }),
      shortcut('search', { global: true, helpOrder: 1 }),
    ]);
    expect(groups.global.map((item) => item.id)).toEqual(['search', 'go-backlog', 'go-sprint', 'help']);
  });

  test('enabled が例外を投げても、その登録だけ出さずに続ける', () => {
    const groups = shortcutHelpGroups([
      shortcut('broken', {
        enabled: () => {
          throw new Error('部品が外れた');
        },
      }),
      shortcut('fine'),
    ]);
    expect(groups.screen.map((item) => item.id)).toEqual(['fine']);
  });

  test('同じ id は1回だけ出す', () => {
    const groups = shortcutHelpGroups([shortcut('a'), shortcut('a')]);
    expect(groups.screen).toHaveLength(1);
  });

  test('登録が空なら両方空', () => {
    expect(shortcutHelpGroups([])).toEqual({ screen: [], global: [] });
  });
});
