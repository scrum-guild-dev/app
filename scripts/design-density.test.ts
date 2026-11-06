// 広い幅でマウスなどだけで操作する画面の詰め（#828。docs/design.md の「どのテーマにも共通すること」の「密度」）。
// タッチの画面を持つ PC（主な入力は pointer: fine、ほかに any-pointer: coarse）は、押せる範囲 44px のための余白を残して詰めない。
// この組み合わせは Playwright でもブラウザの開発者ツールのプロトコルでもまねられず、e2e では確かめられないので、
// 詰めの規則を置いた @media の条件を components.css から読んで確かめる
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const components = readFileSync(new URL('../design/components.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

// 開き括弧の後ろから、対応する閉じ括弧までの中身を返す
function bodyAfter(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(openIndex + 1, i);
  }
  throw new Error('design/components.css の波括弧が閉じていない');
}

// pointer: fine を条件に持つ @media を、条件と中身の組で返す
const fineBlocks = [...components.matchAll(/@media([^{]*\(pointer:\s*fine\)[^{]*)\{/g)].map((match) => ({
  condition: match[1].trim(),
  body: bodyAfter(components, match.index + match[0].length - 1),
}));

test('pointer: fine を条件にする @media は、どれもタッチの画面を持つ端末（any-pointer: coarse）を外す', () => {
  assert.ok(fineBlocks.length > 0, 'design/components.css に pointer: fine を条件にする @media が無い');
  for (const { condition } of fineBlocks) {
    assert.match(
      condition,
      /not \(any-pointer:\s*coarse\)/,
      `@media ${condition} は any-pointer: coarse の端末も詰める。タッチの画面を持つ PC で押せる範囲が狭くなる`,
    );
  }
});

test('行の詰め（台帳の行の min-height: 48px）は、761px 以上でタッチの無い画面だけに効く @media の中にある', () => {
  const dense = fineBlocks.filter(({ body }) => /\.entry\s*\{[^}]*min-height:\s*48px/.test(body));
  assert.equal(dense.length, 1, '台帳の行を詰める規則を置いた @media が1つでない');
  assert.match(dense[0].condition, /\(min-width:\s*761px\)/);
  assert.doesNotMatch(
    components.replace(dense[0].body, ''),
    /\.entry\s*\{[^}]*min-height:\s*48px/,
    '台帳の行を詰める規則が、その @media の外にもある',
  );
});
