import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';
import Drawer from './Drawer.svelte';

const children = createRawSnippet(() => ({ render: () => '<h2 id="title">題</h2>' }));

function html(props: Record<string, unknown>): string {
  return render(Drawer, {
    props: { labelledBy: 'title', onmode: () => {}, onrequestclose: () => {}, children, ...props },
  }).body;
}

describe('前後のタスクへ移るボタン', () => {
  test('順を渡すと、横の帯に「前の」「次の」を開き方の左へ出す', () => {
    const body = html({ adjacent: { hasPrev: true, hasNext: true }, onstep: () => {} });
    expect(body).toContain('class="drawer-steps"');
    expect(body).toContain('aria-label="前の');
    expect(body).toContain('aria-label="次の');
    expect(body.indexOf('drawer-steps')).toBeLessThan(body.indexOf('drawer-mode'));
    expect(body).not.toContain('aria-disabled="true"');
  });

  test('ボタンはキーを aria-keyshortcuts で伝え、title にだけキーを添える（読み上げの名前は変えない）', () => {
    const body = html({ adjacent: { hasPrev: true, hasNext: true }, onstep: () => {} });
    expect(body).toMatch(/aria-label="前の[^"]*"[^>]*aria-keyshortcuts="\["[^>]*title="前の[^"]*（\[）"/);
    expect(body).toMatch(/aria-label="次の[^"]*"[^>]*aria-keyshortcuts="\]"[^>]*title="次の[^"]*（\]）"/);
    expect(body).toMatch(/aria-label="前の[^"（]*"/);
  });

  test('端で押せないボタンの title は、その理由', () => {
    const first = html({ adjacent: { hasPrev: false, hasNext: true }, onstep: () => {} });
    expect(first).toContain('title="先頭です"');
    expect(first).not.toContain('title="最後です"');
    const last = html({ adjacent: { hasPrev: true, hasNext: false }, onstep: () => {} });
    expect(last).toContain('title="最後です"');
    expect(last).not.toContain('title="先頭です"');
  });

  test('真ん中の枠にも出す', () => {
    const body = html({ mode: 'center', adjacent: { hasPrev: true, hasNext: true }, onstep: () => {} });
    expect(body).toContain('class="drawer-steps"');
  });

  test('先頭では「前の」だけ、末尾では「次の」だけが aria-disabled', () => {
    const first = html({ adjacent: { hasPrev: false, hasNext: true }, onstep: () => {} });
    expect(first).toMatch(/aria-label="前の[^"]*"[^>]*aria-disabled="true"/);
    expect(first).toMatch(/aria-label="次の[^"]*"[^>]*aria-disabled="false"/);
    const last = html({ adjacent: { hasPrev: true, hasNext: false }, onstep: () => {} });
    expect(last).toMatch(/aria-label="前の[^"]*"[^>]*aria-disabled="false"/);
    expect(last).toMatch(/aria-label="次の[^"]*"[^>]*aria-disabled="true"/);
  });

  test('順を渡さない画面では出さない', () => {
    expect(html({})).not.toContain('drawer-steps');
    expect(html({ onstep: () => {} })).not.toContain('drawer-steps');
  });

  test('ページ全体では、順を渡されても出さない', () => {
    const body = html({ mode: 'page', adjacent: { hasPrev: true, hasNext: true }, onstep: () => {} });
    expect(body).not.toContain('drawer-steps');
  });

  test('前後のボタンの呼び名は、渡さなければタスク、渡せばその言葉（ストーリーの引き出し）', () => {
    const base = { adjacent: { hasPrev: true, hasNext: true }, onstep: () => {} };
    expect(html(base)).toContain('aria-label="前のタスク"');
    const story = html({ ...base, noun: 'ストーリー' });
    expect(story).toContain('aria-label="前のストーリー"');
    expect(story).toContain('aria-label="次のストーリー"');
    expect(story).toContain('aria-label="前後のストーリー"');
    expect(story).not.toContain('タスク');
  });
});

describe('開き方の切り替え', () => {
  test('渡さなければ、横、真ん中、ページ全体、新しいタブの4つを、名前を持つアイコンのボタンで出す', () => {
    const body = html({});
    const icons = { 横: 'panel', 真ん中: 'centered', ページ全体: 'maximize', 新しいタブ: 'external' };
    for (const [name, icon] of Object.entries(icons)) {
      expect(body).toMatch(
        new RegExp(`aria-label="${name}" title="${name}"[^>]*>\\s*<svg[^>]*><use href="#i-${icon}"`),
      );
    }
  });

  test('今描いている形のボタンだけに aria-pressed="true" を付ける', () => {
    const body = html({ mode: 'center' });
    expect(body.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(body).toMatch(/aria-label="真ん中" title="真ん中" aria-pressed="true"/);
  });

  test('形を渡せば、その形だけを出す（ストーリーの引き出しは横と真ん中だけ）', () => {
    const body = html({ modes: ['side', 'center'] });
    expect(body).toContain('aria-label="横"');
    expect(body).toContain('aria-label="真ん中"');
    expect(body).not.toContain('ページ全体');
    expect(body).not.toContain('新しいタブ');
  });

  test('出せる形が1つだけなら、切り替えの組ごと出さない（選べる形が無いのに既定を書き換える入口にしない）', () => {
    const body = html({ modes: ['side'] });
    expect(body).not.toContain('drawer-mode');
    expect(body).not.toContain('aria-label="横"');
    expect(html({ modes: ['side', 'center'] })).toContain('drawer-mode');
  });
});
