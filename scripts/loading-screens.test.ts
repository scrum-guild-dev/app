import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { screens } from './loading-screens.ts';
import { operations } from '../src/shared/operations/index.ts';
import { isOutsideOperation } from '../src/shared/operations/define.ts';
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );
}
test('全 load の操作が計測表にあり、load の変更時に追従漏れを検出する', () => {
  const definitions = new Map<string, string>();
  for (const file of files('src/shared/operations').filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/export const (\w+) = defineOperation\(\{\s*name: '([^']+)'/g))
      definitions.set(match[1]!, match[2]!);
  }
  for (const file of files('src/routes').filter((f) => /\+(page|layout)\.ts$/.test(f))) {
    const source = readFileSync(file, 'utf8');
    if (!/export const load/.test(source)) continue;
    const route =
      '/' +
      file
        .replace(/^src\/routes\//, '')
        .replace(/\/\+page\.ts$/, '')
        .replace(/^\+page\.ts$/, '')
        .replace(/\.ts$/, '');
    const screen = screens.find((s) => s.route === route);
    assert.ok(screen, `計測表に load がない: ${file}`);
    const names = [
      ...new Set(
        [...source.matchAll(/callOperation\(\s*(\w+)/g)].map((m) => {
          const name = definitions.get(m[1]!);
          assert.ok(name, `操作定義が解決できない: ${m[1]}`);
          return name;
        }),
      ),
    ];
    // 組織の枠の招待だけは通常経路で呼ばない。追加の行で測る。
    const measured = screen.operations.map((o) => o.name);
    if (route === '/[slug]/+layout') {
      const invited = screens.find((s) => s.route === '/[slug]/+layout（招待あり）');
      assert.ok(invited);
      measured.push(...(invited.after ?? []).map((o) => o.name));
    }
    assert.deepEqual([...measured].sort(), names.sort(), file);
  }
});

test('計測表は読み取りだけで、入力とURLの範囲が操作定義に合う', () => {
  for (const screen of screens) {
    for (const reading of [...screen.operations, ...(screen.after ?? [])]) {
      const definition = operations.find((op) => op.name === reading.name);
      assert.ok(definition, reading.name);
      assert.equal(definition.mode, 'read', reading.name);
      assert.equal(isOutsideOperation(definition), reading.global, reading.name);
      assert.equal(definition.input.safeParse(reading.input).success, true, reading.name);
    }
  }
});
