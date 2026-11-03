import { describe, expect, test } from 'vitest';
import { WorkspaceNavigation } from './workspace-navigation.svelte.ts';

const first = { id: 'one', name: '架空の開発チーム', role: 'member' as const };
const second = { id: 'two', name: '架空の保守チーム', role: 'leader' as const };
const memberships = [first, second];

describe('組織の画面のワークスペースメニュー', () => {
  test('直接開いたら所属一覧の先頭を使い、所属が無ければ何も選ばない', () => {
    const navigation = new WorkspaceNavigation();
    expect(navigation.select('aoba/user', memberships, null)).toEqual(first);
    expect(navigation.select('aoba/user', [second], null)).toEqual(second);
    expect(navigation.select('aoba/user', [], null)).toBeNull();
  });

  test('直前に開いた所属先を覚え、今日やることへ戻っても同じ対象を使う', () => {
    const navigation = new WorkspaceNavigation();
    navigation.remember('aoba/user', memberships, second);
    expect(navigation.select('aoba/user', memberships, null)).toEqual(second);
    // 開いた画面は記憶より優先する。
    expect(navigation.select('aoba/user', memberships, first)).toEqual(first);
  });

  test('名前とロールは記憶せず、今の所属一覧から取り直す', () => {
    const navigation = new WorkspaceNavigation();
    navigation.remember('aoba/user', memberships, second);
    const changed = { ...second, name: '架空の新しい名前', role: 'member' as const };
    expect(navigation.select('aoba/user', [first, changed], null)).toEqual(changed);
  });

  test('脱退した対象を使わず、所属0件になった記憶も持ち越さない', () => {
    const navigation = new WorkspaceNavigation();
    navigation.remember('aoba/user', memberships, second);
    expect(navigation.select('aoba/user', [first], null)).toEqual(first);
    expect(navigation.select('aoba/user', [], null)).toBeNull();
    navigation.remember('aoba/user', [], null);
    expect(navigation.select('aoba/user', memberships, null)).toEqual(first);
  });

  test.each(['hibari/user', 'aoba/other-user'])('別の組織や本人（%s）へ記憶を持ち越さない', (scope) => {
    const navigation = new WorkspaceNavigation();
    navigation.remember('aoba/user', memberships, second);
    expect(navigation.select(scope, memberships, null)).toEqual(first);
    navigation.remember(scope, memberships, null);
    expect(navigation.select('aoba/user', memberships, null)).toEqual(first);
  });

  test('所属していない管理者の閲覧中の対象は出すが、今日やることに持ち越さない', () => {
    const navigation = new WorkspaceNavigation();
    const other = { id: 'other', name: '架空の管理対象', role: null };
    navigation.remember('aoba/admin', memberships, second);
    expect(navigation.select('aoba/admin', memberships, other)).toEqual(other);
    navigation.remember('aoba/admin', memberships, other);
    expect(navigation.select('aoba/admin', memberships, null)).toEqual(second);
    navigation.remember('aoba/admin', [], other);
    expect(navigation.select('aoba/admin', [], other)).toEqual(other);
    expect(navigation.select('aoba/admin', [], null)).toBeNull();
  });
});
