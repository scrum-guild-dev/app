// 境界: GitHub に固有の値と処理は src/server/import/github/ の外に出さない。
// 直下の共通の型と表の文字列に、通信先と PAT の接頭辞が無いことを、?raw の原文で確かめる
import { describe, expect, test } from 'vitest';
import indexSource from '../../src/server/import/index.ts?raw';
import sourceSource from '../../src/server/import/source.ts?raw';

const files: [string, string][] = [
  ['source.ts', sourceSource],
  ['index.ts', indexSource],
];

describe('取り込み元の共通の部分に GitHub 固有の値が無い', () => {
  test.each(files)('%s に通信先が無い', (_name, text) => {
    expect(text).not.toContain('api.github.com');
    expect(text).not.toContain('github.com');
  });

  test.each(files)('%s に PAT の接頭辞が無い', (_name, text) => {
    expect(text).not.toContain('github_pat_');
    expect(text).not.toContain('ghp_');
  });

  test.each(files)('%s に API の版の値が無い', (_name, text) => {
    expect(text).not.toContain('2022-11-28');
    expect(text).not.toContain('application/vnd.github');
  });

  test('index.ts が github の実装を読むのは表のためだけ（./github/index.ts のみ）', () => {
    const imports = [...indexSource.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.filter((p) => p!.includes('github'))).toEqual(['./github/index.ts']);
  });
});
