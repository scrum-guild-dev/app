import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  loadingShape,
  loadingShapeCounts,
  loadingShapeHasActions,
  loadingShapes,
  type LoadingShape,
} from '../src/lib/loading-shape.ts';

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

  test('形ごとに本文の骨組みを組み立て、帯の数は移る間の骨組み（LoadingSheet）と同じ', () => {
    const sampleRoute: Record<LoadingShape, string> = {
      aside: '/[slug]',
      tree: '/[slug]/w/[id]',
      board: '/[slug]/w/[id]/sprint',
      plan: '/[slug]/w/[id]/plan',
      list: '/[slug]/w/[id]/inbox',
      settings: '/[slug]/w/[id]/settings',
      wiki: '/[slug]/w/[id]/wiki',
      task: '/[slug]/w/[id]/tasks/[taskId]',
    };
    // 帯の数は src/lib/loading-shape.ts の loadingShapeCounts（LoadingSheet が並べる数）から決める。
    // 形ごとの固定の帯（見出し、カード、脇の欄など）は LoadingSheet.svelte の並びと同じ数を書く。見出しの右のボタン（plan と wiki）も is-button に数える
    const c = loadingShapeCounts;
    const expected: Record<LoadingShape, Record<string, number>> = {
      aside: { 'is-heading': 2, 'is-card': 2, 'is-panel': 1 },
      tree: { 'is-input': 1, 'is-select': c.treeSelects, 'is-item': c.treeRows },
      board: { 'boot-col': c.boardColumns, 'is-card': c.boardColumns * 2 },
      plan: { 'is-chart': 1, 'is-lane': c.planLanes, 'is-button': 1 },
      list: { 'is-heading': 1, 'is-item': c.listRows },
      settings: { 'is-setting': c.settingSections, 'is-card': c.settingSections },
      wiki: { 'is-input': 1, 'is-panel': 1, 'is-button': 2 },
      task: { 'is-button': c.taskButtons, 'is-label': c.taskFields, 'is-value': c.taskFields, 'is-card': 2 },
    };
    const count = (html: string, name: string) =>
      [...html.matchAll(/class="([^"]*)"/g)].filter((match) => match[1].split(' ').includes(name)).length;
    for (const shape of loadingShapes) {
      assert.equal(loadingShape(sampleRoute[shape]), shape);
      const { content } = runBootShape(samplePath(sampleRoute[shape]));
      assert.equal(count(content.innerHTML, 'boot-body'), 1, shape);
      assert.equal(count(content.innerHTML, 'boot-head'), shape === 'task' ? 0 : 1, shape);
      for (const [name, n] of Object.entries(expected[shape])) {
        assert.equal(count(content.innerHTML, name), n, `${shape} の ${name}`);
      }
      assert.equal(loadingShapeHasActions(shape), shape === 'plan' || shape === 'wiki', shape);
    }
  });

  test('組み立てる骨組みのクラスは、どれも static/boot-loading.css に描き方がある', () => {
    const css = readFileSync(new URL('../static/boot-loading.css', import.meta.url), 'utf8');
    const names = new Set<string>();
    for (const shape of loadingShapes) {
      const id = routeIds().find((routeId) => loadingShape(routeId) === shape);
      assert.ok(id, shape);
      for (const match of runBootShape(samplePath(id)).content.innerHTML.matchAll(/class="([^"]*)"/g)) {
        for (const name of match[1].split(' ')) names.add(name);
      }
    }
    // コメントを除き、クラス名の境界まで見る（.is-item が .is-items やコメントの文字に当たらないように）
    const rules = css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
    for (const name of names) {
      assert.match(rules, new RegExp(`\\.${name}(?![\\w-])`), `.${name} が static/boot-loading.css に無い`);
    }
  });

  test('URL の区切りは文字に直して比べ、直せない URL は紙の形のまま', () => {
    assert.equal(runBootShape('/%6Cogin').dataset.boot, undefined);
    assert.equal(runBootShape('/aoba/w/x/sp%72int').dataset.boot, 'board');
    assert.equal(runBootShape('/aoba/%E0%A4%A').dataset.boot, undefined);
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
