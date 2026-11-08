import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../static/boot-shape.js', import.meta.url), 'utf8');

// 最初の読み込みの骨組みの形の先当て（static/boot-shape.js）を、偽の location と localStorage と document で動かす
function runBootShape(pathname: string, stored: string | null = null): { boot?: string; bootNav?: string } {
  const dataset: { boot?: string; bootNav?: string } = {};
  vm.runInNewContext(script, {
    location: { pathname },
    localStorage: { getItem: (key: string) => (key === 'sg-nav-collapsed' ? stored : null) },
    document: { documentElement: { dataset } },
  });
  return dataset;
}

describe('最初の読み込みの骨組みの形（static/boot-shape.js）', () => {
  test('組織の枠の中の URL は枠の形にする', () => {
    assert.equal(runBootShape('/aoba').boot, 'frame');
    assert.equal(runBootShape('/aoba/w/app/backlog').boot, 'frame');
  });

  test('枠の外の URL は紙の形のまま', () => {
    for (const pathname of ['/', '/login', '/consent', '/invite/abc', '/operator', '/privacy', '/signup', '/terms']) {
      assert.equal(runBootShape(pathname).boot, undefined, pathname);
    }
  });

  test('枠の外の画面の名前は src/routes の [slug] 以外の入口と同じ', () => {
    const routes = readdirSync(new URL('../src/routes', import.meta.url), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('['))
      .map((entry) => entry.name)
      .sort();
    const listed = /var outside = (\[[^\]]*\])/.exec(script)?.[1];
    assert.ok(listed);
    assert.deepEqual(JSON.parse(listed.replaceAll("'", '"')), routes);
  });

  test('左のメニューを畳んだと覚えていれば、畳んだ列の形にする', () => {
    assert.equal(runBootShape('/aoba', 'true').bootNav, 'collapsed');
    assert.equal(runBootShape('/aoba', 'false').bootNav, undefined);
    assert.equal(runBootShape('/login', 'true').bootNav, undefined);
  });

  test('畳んだ状態のキーは src/lib/nav-collapse.svelte.ts と同じ', () => {
    const source = readFileSync(new URL('../src/lib/nav-collapse.svelte.ts', import.meta.url), 'utf8');
    assert.match(source, /export const NAV_COLLAPSED_KEY = 'sg-nav-collapsed';/);
    assert.match(script, /localStorage\.getItem\('sg-nav-collapsed'\) === 'true'/);
  });

  test('localStorage が使えなくても落ちず、広げた列の枠にする', () => {
    const dataset: { boot?: string; bootNav?: string } = {};
    const context = vm.createContext({ location: { pathname: '/aoba' }, document: { documentElement: { dataset } } });
    Object.defineProperty(context, 'localStorage', {
      get() {
        throw new Error('SecurityError');
      },
    });
    assert.doesNotThrow(() => vm.runInContext(script, context));
    assert.equal(dataset.boot, 'frame');
    assert.equal(dataset.bootNav, undefined);
  });
});
