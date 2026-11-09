import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { dropWoff, fontsourceWoff2Only } from './fontsource-woff2.ts';

const face = `@font-face {
  font-family: 'Noto Sans JP';
  font-weight: 400;
  src: url(./files/noto-sans-jp-0-400-normal.woff2) format('woff2'), url(./files/noto-sans-jp-0-400-normal.woff) format('woff');
  unicode-range: U+25ee8,U+25f23;
}`;

describe('fontsource の woff を外す', () => {
  test('src から woff だけを外し、woff2 と unicode-range を残す', () => {
    const out = dropWoff(face);
    assert.match(out, /src: url\(\.\/files\/noto-sans-jp-0-400-normal\.woff2\) format\('woff2'\);/);
    assert.doesNotMatch(out, /\.woff\)/);
    assert.match(out, /unicode-range: U\+25ee8,U\+25f23;/);
  });

  test('可変版は全ての文字範囲と太さを保ち、共通の書体名で配る', () => {
    const css = readFileSync(
      new URL('../node_modules/@fontsource-variable/noto-sans-jp/index.css', import.meta.url),
      'utf8',
    );
    const transform = fontsourceWoff2Only().transform as (code: string, id: string) => { code: string } | null;
    const out = transform(css, '/repo/node_modules/@fontsource-variable/noto-sans-jp/index.css?direct')!.code;
    const faces = out.match(/@font-face\s*\{[^}]+\}/g)!;
    assert.equal(faces.length, 124);
    for (const face of faces) {
      assert.match(face, /font-family: 'Noto Sans JP';/);
      assert.match(face, /font-weight: 100 900;/);
      assert.match(face, /font-display: swap;/);
      assert.match(face, /\.woff2\) format\('woff2-variations'\)/);
      assert.match(face, /unicode-range: U\+/);
    }
    assert.deepEqual(out.match(/unicode-range:[^;]+;/g), css.match(/unicode-range:[^;]+;/g));
    assert.deepEqual(out.match(/src:[^;]+;/g), css.match(/src:[^;]+;/g));
    assert.doesNotMatch(out, /Noto Sans JP Variable|\.woff\)/);
    // 別の可変書体を誤って同じ名前へ変えない。
    assert.equal(transform(css, '/repo/node_modules/@fontsource-variable/other/index.css'), null);
  });

  test('可変版の書体名が変わったら黙って代替書体にせず停止する', () => {
    const transform = fontsourceWoff2Only().transform as (code: string, id: string) => { code: string } | null;
    for (const css of ["@font-face { font-family: 'Renamed'; }", '@font-face { font-weight: 100 900; }']) {
      assert.throws(
        () => transform(css, '/repo/node_modules/@fontsource-variable/noto-sans-jp/index.css'),
        /Noto Sans JP/,
      );
    }
  });

  test('プラグインは @fontsource の CSS だけを書き換える', () => {
    const plugin = fontsourceWoff2Only();
    const transform = plugin.transform as (code: string, id: string) => { code: string } | null;
    assert.equal(
      transform.call({}, face, '/repo/node_modules/@fontsource/noto-sans-jp/400.css')?.code.includes('.woff)'),
      false,
    );
    assert.equal(transform.call({}, face, '/repo/design/components.css'), null);
    assert.equal(transform.call({}, face, '/repo/node_modules/@fontsource/noto-sans-jp/index.js'), null);
  });
});
