import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { loadingShape, loadingShapes } from '../src/lib/loading-shape.ts';

const script = readFileSync(new URL('../static/boot-shape.js', import.meta.url), 'utf8');
const routesDir = fileURLToPath(new URL('../src/routes', import.meta.url));

type BootDataset = { boot?: string; bootNav?: string };
type FakeContent = { innerHTML: string };

// 最初の読み込みの骨組みの先当て（static/boot-shape.js）を、偽の location と localStorage と document で動かす
function runBootShape(pathname: string, stored: string | null = null): { dataset: BootDataset; content: FakeContent } {
  const dataset: BootDataset = {};
  const content: FakeContent = { innerHTML: '' };
  vm.runInNewContext(script, {
    location: { pathname },
    localStorage: { getItem: (key: string) => (key === 'sg-nav-collapsed' ? stored : null) },
    document: {
      documentElement: { dataset },
      querySelector: (selector: string) => (selector === '#boot-loading .boot-content' ? content : null),
    },
  });
  return { dataset, content };
}

// src/routes の +page.svelte から、画面の route.id（/[slug]/w/[id] など）を集める
function routeIds(dir = routesDir): string[] {
  const ids: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) ids.push(...routeIds(path));
    else if (entry.name === '+page.svelte') ids.push(`/${relative(routesDir, dir)}`.replace(/\/$/, '') || '/');
  }
  return ids.sort();
}

// route.id の引数を、ありそうな値に置き換えた URL にする
const samplePath = (routeId: string) => routeId.replaceAll(/\[([^\]]+)\]/g, (_, name: string) => `sample-${name}`);

describe('最初の読み込みの骨組みの形（static/boot-shape.js）', () => {
  test('どの画面の URL でも、移る間の骨組み（src/lib/loading-shape.ts）と同じ形を選ぶ', () => {
    const ids = routeIds();
    assert.ok(ids.includes('/[slug]/w/[id]/sprint'));
    for (const id of ids) {
      for (const path of [samplePath(id), `${samplePath(id)}/`]) {
        assert.equal(runBootShape(path).dataset.boot, loadingShape(id) ?? undefined, `${id}（${path}）`);
      }
    }
  });

  test('組織の枠の中の画面は、どれも形を明示して決めている（既定の一覧の形に落ちない）', () => {
    const source = readFileSync(new URL('../src/lib/loading-shape.ts', import.meta.url), 'utf8');
    for (const id of routeIds().filter((id) => id.startsWith('/[slug]'))) {
      assert.ok(source.includes(`'${id}':`), `${id} が src/lib/loading-shape.ts の対応に無い`);
    }
  });

  test('枠の外の URL と、どの画面にも当たらない URL は紙の形のまま', () => {
    for (const pathname of ['/', '/login', '/invite/abc', '/aoba/invitations', '/aoba/unknown', '/aoba/w/x/unknown']) {
      const { dataset, content } = runBootShape(pathname);
      assert.equal(dataset.boot, undefined, pathname);
      assert.equal(content.innerHTML, '', pathname);
    }
  });

  test('枠の外の画面の名前は src/routes の [slug] 以外の入口と同じ', () => {
    const routes = readdirSync(routesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('['))
      .map((entry) => entry.name)
      .sort();
    const listed = /var outside = (\[[^\]]*\])/.exec(script)?.[1];
    assert.ok(listed);
    assert.deepEqual(JSON.parse(listed.replaceAll("'", '"')), routes);
  });

  test('形ごとに本文の骨組みを組み立て、タスクだけは見出しを持たない', () => {
    for (const shape of loadingShapes) {
      const id = Object.entries({
        aside: '/[slug]',
        tree: '/[slug]/w/[id]',
        board: '/[slug]/w/[id]/sprint',
        plan: '/[slug]/w/[id]/plan',
        list: '/[slug]/w/[id]/inbox',
        settings: '/[slug]/w/[id]/settings',
        wiki: '/[slug]/w/[id]/wiki',
        task: '/[slug]/w/[id]/tasks/[taskId]',
      }).find(([key]) => key === shape)?.[1];
      assert.ok(id, shape);
      assert.equal(loadingShape(id), shape);
      const { content } = runBootShape(samplePath(id));
      assert.match(content.innerHTML, /<b class="boot-body">/, shape);
      assert.equal(content.innerHTML.includes('boot-head'), shape !== 'task', shape);
    }
  });

  test('左のメニューを畳んだと覚えていれば、畳んだ列の形にする', () => {
    assert.equal(runBootShape('/aoba', 'true').dataset.bootNav, 'collapsed');
    assert.equal(runBootShape('/aoba', 'false').dataset.bootNav, undefined);
    assert.equal(runBootShape('/login', 'true').dataset.bootNav, undefined);
  });

  test('畳んだ状態のキーは src/lib/nav-collapse.svelte.ts と同じ', () => {
    const source = readFileSync(new URL('../src/lib/nav-collapse.svelte.ts', import.meta.url), 'utf8');
    assert.match(source, /export const NAV_COLLAPSED_KEY = 'sg-nav-collapsed';/);
    assert.match(script, /localStorage\.getItem\('sg-nav-collapsed'\) === 'true'/);
  });

  test('localStorage が使えなくても落ちず、広げた列の枠にする', () => {
    const dataset: BootDataset = {};
    const context = vm.createContext({
      location: { pathname: '/aoba' },
      document: { documentElement: { dataset }, querySelector: () => ({ innerHTML: '' }) },
    });
    Object.defineProperty(context, 'localStorage', {
      get() {
        throw new Error('SecurityError');
      },
    });
    assert.doesNotThrow(() => vm.runInContext(script, context));
    assert.equal(dataset.boot, 'aside');
    assert.equal(dataset.bootNav, undefined);
  });
});
