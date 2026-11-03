import { expect, test } from 'vitest';
import type { WikiNode } from '../shared/operations/wiki/index.ts';
import { wikiAncestorIds, wikiMoveOptions } from './wiki-move.ts';
function node(id: string, parent_id: string | null = null): WikiNode {
  return { id, parent_id, title: id, position: 'a0', version: 1 };
}
test('親候補は自分と子孫を除き、木の順と深さを保つ', () => {
  const pages = [node('a'), node('c', 'a'), node('b'), node('d', 'c'), node('e', 'b')];
  expect(wikiMoveOptions(pages, 'c')).toEqual([
    { id: 'a', title: 'a', depth: 1, disabled: false },
    { id: 'b', title: 'b', depth: 1, disabled: false },
    { id: 'e', title: 'e', depth: 2, disabled: false },
  ]);
});
test('部分木の高さを含め、10段なら選べて11段なら選べない', () => {
  const chain = Array.from({ length: 9 }, (_, i) => node(`p${i}`, i ? `p${i - 1}` : null));
  const options = wikiMoveOptions([...chain, node('moving'), node('child', 'moving')], 'moving');
  expect(options.find((p) => p.id === 'p7')?.disabled).toBe(false);
  expect(options.find((p) => p.id === 'p8')?.disabled).toBe(true);
});
test('移す先が閉じた深い枝でも、祖先すべてを開くためのIDを返す', () => {
  expect(wikiAncestorIds([node('root'), node('branch', 'root'), node('parent', 'branch')], 'parent')).toEqual([
    'parent',
    'branch',
    'root',
  ]);
});
test('不整合な循環データでも有限で終わる', () => {
  const pages = [node('a', 'b'), node('b', 'a')];
  expect(wikiAncestorIds(pages, 'a')).toEqual(['a', 'b']);
  expect(wikiMoveOptions(pages, 'a')).toEqual([]);
});
