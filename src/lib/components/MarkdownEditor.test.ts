import { render } from 'svelte/server';
import { expect, test } from 'vitest';
import MarkdownEditor from './MarkdownEditor.svelte';

const props = { value: '書きかけの本文', slug: 'aoba', workspaceId: 'w1', id: 'body' };

test('起票前の本文は編集でき、添付を無効にするとファイル選択の入口を出さない', () => {
  const body = render(MarkdownEditor, { props: { ...props, attachments: false } }).body;
  expect(body).toContain('書きかけの本文');
  expect(body).toContain('<textarea');
  expect(body).not.toContain('type="file"');
  expect(body).not.toContain('class="dropzone"');
  expect(body).toContain('class="slash-menu"');
});

test('既存の本文欄は指定を省くと添付の入口を保つ', () => {
  const body = render(MarkdownEditor, { props }).body;
  expect(body).toContain('type="file"');
  expect(body).toContain('class="dropzone"');
  expect(body).not.toContain('class="markdown-toolbar"');
});

test('指定した本文欄だけに、名前を持つ4つの書式ボタンを出す', () => {
  const body = render(MarkdownEditor, { props: { ...props, toolbar: true, readonly: true } }).body;
  expect(body).toContain('class="markdown-toolbar"');
  for (const name of ['箇条書き', 'チェックリスト', 'コード', '引用']) {
    expect(body).toContain(`aria-label="${name}"`);
  }
  expect(body.match(/<button[^>]* disabled/g)?.length).toBe(5);
});

test('ワークスペースの外の欄（組織の Wiki）は、添付を止めて行数を指定して描ける', () => {
  const body = render(MarkdownEditor, {
    props: { ...props, workspaceId: null, attachments: false, rows: 20 },
  }).body;
  expect(body).toMatch(/<textarea[^>]* rows="20"/);
  expect(body).not.toContain('type="file"');
  expect(body).toContain('class="slash-menu"');
});
