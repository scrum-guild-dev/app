import { describe, expect, it } from 'vitest';
import { backlogSearchHref, matchScreens, searchOptions } from './nav-search.ts';

const screens = [
  { label: 'バックログ', href: '/aoba/w/w1' },
  { label: 'スプリント', href: '/aoba/w/w1/sprint' },
  { label: 'Wiki', href: '/aoba/w/w1/wiki' },
];
const backlog = { href: '/aoba/w/w1', label: (q: string) => `バックログで「${q}」を探す` };

describe('matchScreens', () => {
  it('空の入力は全部、語は大文字小文字と全角半角を見ずに含むものだけ', () => {
    expect(matchScreens('', screens)).toHaveLength(3);
    expect(matchScreens('ＷＩＫＩ', screens).map((s) => s.label)).toEqual(['Wiki']);
    expect(matchScreens('スプ', screens).map((s) => s.label)).toEqual(['スプリント']);
    expect(matchScreens('スプ ばっく', screens)).toEqual([]);
  });
});

describe('backlogSearchHref', () => {
  it('?q= に載せ、空白だけなら行き先を作らない', () => {
    expect(backlogSearchHref('/aoba/w/w1', 'ログイン 画面')).toBe(
      '/aoba/w/w1?q=%E3%83%AD%E3%82%B0%E3%82%A4%E3%83%B3+%E7%94%BB%E9%9D%A2',
    );
    expect(backlogSearchHref('/aoba/w/w1', '   ')).toBeNull();
  });
});

describe('searchOptions', () => {
  it('画面の候補の後ろにバックログの行を足し、ワークスペースが無ければ足さない', () => {
    const options = searchOptions('スプ', screens, backlog);
    expect(options.map((o) => [o.kind, o.label])).toEqual([
      ['screen', 'スプリント'],
      ['backlog', 'バックログで「スプ」を探す'],
    ]);
    expect(searchOptions('スプ', screens, null).map((o) => o.kind)).toEqual(['screen']);
    expect(searchOptions('', screens, backlog).map((o) => o.kind)).toEqual(['screen', 'screen', 'screen']);
  });
});
