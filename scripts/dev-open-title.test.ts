import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { installDevOpenTitle } from './dev-open-title.ts';

const origin = 'http://localhost:5489';
const worktree = '1198-review-window';
const label = '手元の確かめ｜1198-review-window';

// 初期スクリプトのシリアライズ後の関数を、ページごとに独立した環境で動かす。
// title の書き込みも次の通知を起こし、接頭辞の重複や監視の無限ループを検出する。
function page(title: string, options: { origin?: string; frame?: boolean; head?: boolean } = {}) {
  let head = options.head ?? true;
  let pending = false;
  let notify: (() => void) | undefined;
  let writes = 0;
  const document = {
    get title() {
      return title;
    },
    set title(value: string) {
      if (!head) return;
      title = value;
      writes++;
      pending = true;
    },
  };
  const self = {};
  runInNewContext(`(${installDevOpenTitle.toString()})(input)`, {
    input: { origin, worktree },
    window: { self, top: options.frame ? {} : self },
    location: { origin: options.origin ?? origin },
    document,
    MutationObserver: class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe(target: unknown, config: unknown) {
        assert.equal(target, document);
        assert.deepEqual(JSON.parse(JSON.stringify(config)), { childList: true, subtree: true, characterData: true });
      }
    },
  });
  const flush = () => {
    for (let i = 0; pending && i < 10; i++) {
      pending = false;
      notify?.();
    }
    assert.equal(pending, false, '題の書き換えが通知を繰り返さない');
  };
  flush();
  return {
    document,
    get writes() {
      return writes;
    },
    changeTitle(value: string) {
      head = true;
      title = value;
      pending = true;
      flush();
    },
    mutateBody() {
      pending = true;
      flush();
    },
  };
}

test('元の題を残し、手元の確かめとワークツリー名を付ける', () => {
  const p = page('バックログ｜Scrum Guild');
  assert.equal(p.document.title, `${label}｜バックログ｜Scrum Guild`);
  assert.equal(p.writes, 1);
  p.mutateBody();
  assert.equal(p.writes, 1);
});

test('SPA が題を変えるたび、新しい題に接頭辞を1回だけ付ける', () => {
  const p = page('組織');
  p.changeTitle('スプリント');
  assert.equal(p.document.title, `${label}｜スプリント`);
  p.changeTitle('Wiki');
  assert.equal(p.document.title, `${label}｜Wiki`);
  p.changeTitle(`${label}｜Wiki`);
  assert.equal(p.writes, 3);
});

test('head の無い初期化の後で title が追加されても識別できる', () => {
  const p = page('', { head: false });
  assert.equal(p.document.title, '');
  p.changeTitle('ホーム');
  assert.equal(p.document.title, `${label}｜ホーム`);
});

test('空の題にも付け、独立した初期化同士で状態を共有しない', () => {
  assert.equal(page('').document.title, label);
  assert.equal(page('ホーム').document.title, `${label}｜ホーム`);
  assert.equal(page('ホーム').document.title, `${label}｜ホーム`);
  assert.equal(page(label).writes, 0);
});

test('本番・別ポート・埋め込みの題を変えない', () => {
  for (const options of [
    { origin: 'https://scrum-guild.ucan-lab.workers.dev' },
    { origin: 'http://localhost:5490' },
    { frame: true },
  ]) {
    const p = page('ホーム', options);
    assert.equal(p.document.title, 'ホーム');
    p.changeTitle('設定');
    assert.equal(p.document.title, '設定');
    assert.equal(p.writes, 0);
  }
});
