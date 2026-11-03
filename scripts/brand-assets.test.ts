import assert from 'node:assert/strict';
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = new URL('../design/brand/', import.meta.url);
const target = new URL('../static/brand/', import.meta.url);

test('単独配信する見本と本番のブランド素材がすべて同じバイトで揃う', () => {
  const list = (base: URL) =>
    readdirSync(base, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(fileURLToPath(base), join(entry.parentPath, entry.name)))
      .sort();
  const files = list(source);
  assert.deepEqual(list(target), files);
  assert.ok(files.length >= 12);
  for (const path of files) {
    assert.deepEqual(readFileSync(new URL(path, target)), readFileSync(new URL(path, source)), path);
  }
});

test('faviconの宣言は存在するICO / PNGだけで、旧SVGを選ばせない', () => {
  const html = readFileSync(new URL('../src/app.html', import.meta.url), 'utf8');
  const icons = [...html.matchAll(/<link\s[^>]*rel="icon"[^>]*>/g)].map(([tag]) => tag);
  assert.equal(icons.length, 2);
  assert.doesNotMatch(html, /favicon\.svg/);
  for (const tag of icons) {
    const path = /href="%sveltekit\.assets%\/([^"]+)"/.exec(tag)?.[1];
    assert.ok(path);
    assert.ok(readFileSync(new URL(`../static/${path}`, import.meta.url)).length > 0);
  }
  const ico = readFileSync(new URL('favicon/favicon.ico', target));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 3);
  assert.deepEqual(
    [0, 1, 2].map((i) => ico[6 + i * 16]),
    [16, 32, 48],
  );
});

test('素材の同期は削除・改名も反映し、staticのほかのファイルを保つ', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sg-brand-'));
  try {
    for (const dir of ['scripts', 'design/brand/header', 'static/brand']) {
      mkdirSync(join(scratch, dir), { recursive: true });
    }
    copyFileSync(new URL('./generate-favicon.ts', import.meta.url), join(scratch, 'scripts/generate-favicon.ts'));
    writeFileSync(join(scratch, 'design/brand/header/new.png'), 'new brand');
    writeFileSync(join(scratch, 'static/brand/old.png'), 'old brand');
    writeFileSync(join(scratch, 'static/manifest.webmanifest'), 'keep manifest');
    const run = () => {
      const result = spawnSync(process.execPath, [join(scratch, 'scripts/generate-favicon.ts')], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    run();
    assert.equal(existsSync(join(scratch, 'static/brand/old.png')), false);
    assert.equal(readFileSync(join(scratch, 'static/brand/header/new.png'), 'utf8'), 'new brand');
    assert.equal(readFileSync(join(scratch, 'static/manifest.webmanifest'), 'utf8'), 'keep manifest');
    run();
    assert.equal(readFileSync(join(scratch, 'static/brand/header/new.png'), 'utf8'), 'new brand');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
