// design/fonts/ の Guild Mono JP（scripts/guild-mono-jp.py の生成物）が、CSS と実ファイルで食い違わず、
// OFL の予約フォント名「PlemolJP」を名乗らず、ライセンスを同梱していることを確かめる
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const fontsDir = new URL('../design/fonts/', import.meta.url);
const css = readFileSync(new URL('guild-mono-jp.css', fontsDir), 'utf8');
const faces = css.split('@font-face').slice(1);

function ranges(face: string): [number, number][] {
  const value = /unicode-range:\s*([^;]+);/.exec(face)?.[1] ?? '';
  return value.split(',').map((part) => {
    const [start, end = start] = part.trim().replace(/^U\+/i, '').split('-');
    return [parseInt(start ?? '', 16), parseInt(end ?? '', 16)];
  });
}

describe('Guild Mono JP の生成物', () => {
  test('400 と 700 の @font-face があり、どれも Guild Mono JP の woff2 を swap で読む', () => {
    assert.ok(faces.length > 0);
    const weights = new Set<string>();
    for (const face of faces) {
      assert.match(face, /font-family: 'Guild Mono JP';/);
      assert.match(face, /font-display: swap;/);
      assert.match(face, /format\('woff2'\)/);
      weights.add(/font-weight: (\d+);/.exec(face)?.[1] ?? '');
    }
    assert.deepEqual([...weights].sort(), ['400', '700']);
  });

  test('CSS の url と design/fonts/guild-mono-jp/ の woff2 が過不足なく対応する', () => {
    const urls = faces.map((face) => /url\('\.\/guild-mono-jp\/([^']+)'\)/.exec(face)?.[1]);
    assert.ok(urls.every((name) => name !== undefined));
    const files = readdirSync(new URL('guild-mono-jp/', fontsDir)).filter((name) => name.endsWith('.woff2'));
    assert.deepEqual([...urls].sort(), files.sort());
  });

  test('予約フォント名を font-family に使わず、ライセンスを同梱する', () => {
    assert.doesNotMatch(css, /font-family:[^;]*PlemolJP/i);
    const license = new URL('guild-mono-jp/OFL.txt', fontsDir);
    assert.ok(existsSync(license));
    assert.match(readFileSync(license, 'utf8'), /Reserved Font Name "PlemolJP"/);
  });

  test('全角の空白（U+3000）はどの範囲にも入れない', () => {
    // PlemolJP は全角の空白を点線の四角で描くので、端末の書体の空白で組ませる
    for (const face of faces) {
      for (const [start, end] of ranges(face)) {
        assert.ok(!(start <= 0x3000 && 0x3000 <= end), `U+3000 が ${start.toString(16)}-${end.toString(16)} に入る`);
      }
    }
  });
});
