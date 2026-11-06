import { expect, test } from 'vitest';
import { accountScreenKey, workspaceIdOf } from './breadcrumb.ts';

test('ワークスペースの画面の経路だけから ID を取り出す', () => {
  expect(workspaceIdOf('/aoba/w/019a-x/backlog')).toBe('019a-x');
  expect(workspaceIdOf('/aoba/w/019a-x')).toBe('019a-x');
  expect(workspaceIdOf('/aoba')).toBeNull();
  expect(workspaceIdOf('/aoba/wiki')).toBeNull();
  expect(workspaceIdOf('/aoba/me')).toBeNull();
});

test('メニューに無い組織の画面の名前を引く', () => {
  expect(accountScreenKey('/aoba/me', 'aoba')).toBe('pageMe');
  expect(accountScreenKey('/aoba/admin', 'aoba')).toBe('pageOrgAdmin');
  expect(accountScreenKey('/aoba/admin/users', 'aoba')).toBe('pageOrgAdmin');
  expect(accountScreenKey('/aoba', 'aoba')).toBeNull();
  expect(accountScreenKey('/other/me', 'aoba')).toBeNull();
});
