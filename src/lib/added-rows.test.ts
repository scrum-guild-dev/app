import { expect, test } from 'vitest';
import { carriesOver, completionSettled, keepAddedRow, orphanedFromTree } from './added-rows.ts';

const base = { inLoadedTree: false, completed: false, treeLoaded: true, loadedAt: 100 };

test('足した後に始まった読み直しの木に無い行は捨てる（別の人の削除、親ごとの消失）', () => {
  expect(keepAddedRow({ at: 99 }, base)).toBe(false);
});

test('足す前に始まった読み直しが遅れて届いても、木に無い行は残す', () => {
  expect(keepAddedRow({ at: 101 }, base)).toBe(true);
});

test('足した時刻と読み直しを始めた時刻が同じなら残す', () => {
  expect(keepAddedRow({ at: 100 }, base)).toBe(true);
});

test('木を読めていないときは、足した後に始まった読み直しでも残す', () => {
  expect(keepAddedRow({ at: 99 }, { ...base, treeLoaded: false })).toBe(true);
});

test('読み直した木に入った行は捨てる', () => {
  expect(keepAddedRow({ at: 101 }, { ...base, inLoadedTree: true })).toBe(false);
});

test('完了にした行は、木に無くても残さない', () => {
  expect(keepAddedRow({ at: 101 }, { ...base, completed: true })).toBe(false);
});

test('完了の応答が返った後に始まった読み直しは、完了を含むので印を捨てる', () => {
  expect(completionSettled(100, 101)).toBe(true);
});

test('完了の応答より前に始まった読み直しが遅れて届いても、印は残す', () => {
  expect(completionSettled(100, 99)).toBe(false);
});

test('完了の応答と読み直しを始めた時刻が同じなら残す', () => {
  expect(completionSettled(100, 100)).toBe(false);
});

const none = { assignee: '', category: '', repository: '', epic: '', q: '' };

test('同じ絞り込みの木は持ち越す（絞っていても同じ）', () => {
  expect(carriesOver(none, none, true)).toBe(true);
  expect(carriesOver({ ...none, q: 'a' }, { ...none, q: 'a' }, true)).toBe(true);
});

test('絞り込みの条件が替わった木は持ち越さない', () => {
  expect(carriesOver(none, { ...none, q: 'a' }, true)).toBe(false);
  expect(carriesOver({ ...none, q: 'a' }, none, true)).toBe(false);
  expect(carriesOver({ ...none, q: 'a' }, { ...none, q: 'b' }, true)).toBe(false);
});

test('ワークスペースが替わったときと、最初の木は持ち越さない', () => {
  expect(carriesOver(none, none, false)).toBe(false);
  expect(carriesOver(undefined, none, true)).toBe(false);
});

test('orphanedFromTree: 写した行の親が木に無いときだけ孤立とする', () => {
  const ids = new Set(['s1']);
  const row = { storyId: 's2', fromTree: true as const };
  expect(orphanedFromTree(row, { treeLoaded: true, storyIds: ids })).toBe(true);
  expect(orphanedFromTree({ ...row, storyId: 's1' }, { treeLoaded: true, storyIds: ids })).toBe(false);
  expect(orphanedFromTree({ storyId: 's2' }, { treeLoaded: true, storyIds: ids })).toBe(false);
  expect(orphanedFromTree({ ...row, storyId: null }, { treeLoaded: true, storyIds: ids })).toBe(false);
  expect(orphanedFromTree(row, { treeLoaded: false, storyIds: new Set() })).toBe(false);
});
