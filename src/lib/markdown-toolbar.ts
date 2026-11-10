import type { AssistEdit } from './markdown-assist.ts';

export type MarkdownFormat = 'bullet' | 'todo' | 'code' | 'quote';
export const MARKDOWN_FORMATS = [
  { key: 'bullet', label: 'slashBullet', icon: 'list-bullet' },
  { key: 'todo', label: 'slashTodo', icon: 'list-check' },
  { key: 'code', label: 'slashCode', icon: 'code' },
  { key: 'quote', label: 'slashQuote', icon: 'quote' },
] as const;

// 選択末尾が次の行の先頭なら、その行は含めない。カーソルだけなら今の行を使う。
export function toolbarEdit(value: string, from: number, to: number, format: MarkdownFormat): AssistEdit {
  const start = from === 0 ? 0 : value.lastIndexOf('\n', from - 1) + 1;
  const last = to > from && value[to - 1] === '\n' ? to - 1 : to;
  const next = value.indexOf('\n', last);
  const end = next < 0 ? value.length : next;
  if (format === 'code') return codeEdit(value, start, end, from, to);

  const prefix = format === 'bullet' ? '- ' : format === 'todo' ? '- [ ] ' : '> ';
  const pattern = format === 'bullet' ? /^- (?!\[[ xX]\] )/u : format === 'todo' ? /^- \[[ xX]\] /u : /^> /u;
  const lines = value.slice(start, end).split('\n');
  const remove = lines.every((line) => pattern.test(line.replace(/^[ \t]*/u, '')));
  const changes: { at: number; removed: number; added: number }[] = [];
  let offset = start;
  const text = lines
    .map((line) => {
      const indent = /^[ \t]*/u.exec(line)?.[0] ?? '';
      const content = line.slice(indent.length);
      const match = pattern.exec(content);
      const removed = remove ? (match?.[0].length ?? 0) : 0;
      const added = !remove && !match ? prefix : '';
      changes.push({ at: offset + indent.length, removed, added: added.length });
      offset += line.length + 1;
      return indent + added + content.slice(removed);
    })
    .join('\n');
  const move = (position: number) =>
    position +
    changes.reduce(
      (delta, change) =>
        position < change.at ? delta : delta + change.added - Math.min(change.removed, position - change.at),
      0,
    );
  return { start, end, text, selectionStart: move(from), selectionEnd: move(to) };
}

function codeEdit(value: string, start: number, end: number, from: number, to: number): AssistEdit {
  type Block = { start: number; end: number; contentStart: number; contentEnd: number };
  const blocks: Block[] = [];
  let open: { start: number; end: number; mark: string } | null = null;
  let offset = 0;
  for (const line of value.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (match) {
      const mark = match[1]!;
      const info = match[2]!;
      if (open === null) {
        if (!(mark[0] === '`' && info.includes('`'))) open = { start: offset, end: offset + line.length, mark };
      } else if (mark[0] === open.mark[0] && mark.length >= open.mark.length && info.trim() === '') {
        const contentStart = open.end + 1;
        blocks.push({
          start: open.start,
          end: offset + line.length,
          contentStart,
          contentEnd: Math.max(contentStart, offset - 1),
        });
        open = null;
      }
    }
    offset += line.length + 1;
  }
  // 閉じの無い囲みも Markdown では末尾までコード。内側に新しい囲みを重ねない。
  if (open)
    blocks.push({
      start: open.start,
      end: value.length,
      contentStart: Math.min(value.length, open.end + 1),
      contentEnd: value.length,
    });
  const block = blocks.find((entry) => from >= entry.start && to <= entry.end);
  if (block) {
    const move = (position: number) =>
      block.start + Math.max(0, Math.min(position - block.contentStart, block.contentEnd - block.contentStart));
    return {
      start: block.start,
      end: block.end,
      text: value.slice(block.contentStart, block.contentEnd),
      selectionStart: move(from),
      selectionEnd: move(to),
    };
  }
  // 囲みの内外にまたがる選択はブロック全体へ広げ、既存の開始・終了を分断しない。
  for (const entry of blocks) {
    if (start < entry.end && end > entry.start) {
      start = Math.min(start, entry.start);
      end = Math.max(end, entry.end);
    }
  }
  const content = value.slice(start, end);
  const longest = Math.max(2, ...Array.from(content.matchAll(/`+/gu), (match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return {
    start,
    end,
    text: `${fence}\n${content}\n${fence}`,
    selectionStart: from + fence.length + 1,
    selectionEnd: to + fence.length + 1,
  };
}
