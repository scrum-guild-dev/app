import { expect, test, vi } from 'vitest';
import { readWikiFile } from './wiki-files.ts';

test('UTF-8を厳密に読み、BOMやCRLFを本文に保つ', async () => {
  const source = '\uFEFF---\r\ntitle: 題\r\n---\r\n本文';
  const selected = await readWikiFile(new File([source], '題.md'));
  expect(selected.problem).toBeNull();
  expect(selected.body_md).toBe(source);
});
test('UTF-8でないバイトを置換せず拒否する', async () => {
  expect((await readWikiFile(new File([new Uint8Array([0x82, 0xa0])], '題.md'))).problem).toBe('utf8');
});
test('読み取りの失敗を表示できる結果にする', async () => {
  const file = new File(['本文'], '題.md');
  vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('read failed'));
  expect((await readWikiFile(file)).problem).toBe('read');
});
test('大き過ぎるファイルはメモリーに読み込まない', async () => {
  const file = new File(['a'.repeat(400004)], '題.md');
  const read = vi.spyOn(file, 'arrayBuffer');
  expect((await readWikiFile(file)).problem).toBe('too_long');
  expect(read).not.toHaveBeenCalled();
});
