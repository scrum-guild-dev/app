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
});
