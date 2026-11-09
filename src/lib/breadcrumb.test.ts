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
  expect(accountScreenKey('/aoba/me', 'aoba', true)).toBe('pageMe');
  expect(accountScreenKey('/aoba/admin', 'aoba', true)).toBe('pageOrgAdmin');
  expect(accountScreenKey('/aoba/admin/users', 'aoba', true)).toBe('pageOrgAdmin');
  expect(accountScreenKey('/aoba', 'aoba', true)).toBeNull();
  expect(accountScreenKey('/other/me', 'aoba', true)).toBeNull();
  expect(accountScreenKey('/aoba/favorites', 'aoba', false)).toBe('favorites');
  expect(accountScreenKey('/other/favorites', 'aoba', false)).toBeNull();
});

test('管理者でない人には管理の画面名を出さない', () => {
  expect(accountScreenKey('/aoba/admin', 'aoba', false)).toBeNull();
  expect(accountScreenKey('/aoba/admin/users', 'aoba', false)).toBeNull();
  expect(accountScreenKey('/aoba/me', 'aoba', false)).toBe('pageMe');
});
