// Markdown の欄の入力の補助。リストを続ける（Enter）、字下げ（Tab / Shift+Tab）、選んだ文字に URL を貼ってリンクにする。
// 条件と書き換えを DOM から切り離して持つ（欄は MarkdownEditor.svelte）。見本は design/kit.js の continueList。

// 画面のリンクの上限（src/lib/markdown.ts の MAX_URL_LENGTH）と同じ。markdown.ts は変換器を引き込むので、欄の束には入れない
const MAX_URL_LENGTH = 2048;

/** 本文の `start` から `end` までを `text` に置き換え、その後の選択を `selectionStart` から `selectionEnd` に置く。 */
export type AssistEdit = {
  start: number;
  end: number;
  text: string;
  selectionStart: number;
  selectionEnd: number;
};

export type AssistKey = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  keyCode: number;
};

// 字下げ、印、中身。印は「- [ ] 」「- 」「* 」「+ 」「1. 」。チェックリストを先に試す
const LIST_LINE = /^([ \t]*)(- \[[ xX]\] |[-*+] |\d{1,9}[.)] )([^\n]*)$/u;

type ListLine = { indent: string; mark: string; content: string; start: number; end: number };

function lineBounds(value: string, position: number): { start: number; end: number } {
  const start = position === 0 ? 0 : value.lastIndexOf('\n', position - 1) + 1;
  const next = value.indexOf('\n', position);
  return { start, end: next === -1 ? value.length : next };
}

function listLine(value: string, position: number): ListLine | null {
  const { start, end } = lineBounds(value, position);
  const text = value.slice(start, end);
  // 区切り線（`- - -`、`* * *`）は一覧の項目ではない
  if (/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/u.test(text)) return null;
  const match = LIST_LINE.exec(text);
  return match === null ? null : { indent: match[1] ?? '', mark: match[2] ?? '', content: match[3] ?? '', start, end };
}

// コードの囲みの中の行は、一覧として扱わない。囲みを前から読み、種類（` か ~）と長さが同じ以上の閉じで閉じる（CommonMark）
function inFence(value: string, lineStart: number): boolean {
  let open: { char: string; length: number } | null = null;
  for (const line of value.slice(0, lineStart).split('\n')) {
    const match = /^ *(`{3,}|~{3,})(.*)$/u.exec(line);
    const mark = match?.[1];
    const info = match?.[2] ?? '';
    if (mark === undefined) continue;
    if (open === null) {
      // 情報文字列にバッククォートを含む行は、囲みの開きでなくインラインのコード
      if (mark.startsWith('`') && info.includes('`')) continue;
      open = { char: mark.charAt(0), length: mark.length };
    } else if (mark.charAt(0) === open.char && mark.length >= open.length && info.trim() === '') open = null;
  }
  return open !== null;
}

// 子の字下げの幅は、親の項目の中身が始まる桁（「- 」は2、「1. 」は3）。そうしないと CommonMark で入れ子にならない
const markWidth = (mark: string): number => (/^\d/u.test(mark) ? mark.length : 2);

// 位置の直前にある、字下げが `indent` 以下の最も近いリストの行（親になりうる行）
function previousParent(value: string, lineStart: number, indent: number): ListLine | null {
  let position = lineStart;
  while (position > 0) {
    const line = listLine(value, position - 1);
    if (line === null) return null;
    if (line.indent.length <= indent) return line;
    position = line.start;
  }
  return null;
}

/** Enter: カーソルが行末にある一覧の項目の次に、同じ種類の項目を足す。中身が空の項目では、印を消して一覧を抜ける。 */
export function continueListEdit(value: string, start: number, end: number): AssistEdit | null {
  // 範囲を選んでいるときと、カーソルの後ろに文字があるときは、普通の改行に任せる
  if (start !== end) return null;
  const line = listLine(value, start);
  if (line === null || start !== line.end || inFence(value, line.start)) return null;
  if (line.content.trim() === '') {
    return { start: line.start, end: line.end, text: '', selectionStart: line.start, selectionEnd: line.start };
  }
  const number = /^(\d{1,9})([.)]) $/u.exec(line.mark);
  // 次の番号が10桁になると、CommonMark の項目ではなくなる
  if (number !== null && Number(number[1]) + 1 > 999_999_999) return null;
  const mark =
    number !== null
      ? `${Number(number[1]) + 1}${number[2] ?? '.'} `
      : /^- \[[ xX]\] $/u.test(line.mark)
        ? '- [ ] '
        : line.mark;
  const text = `\n${line.indent}${mark}`;
  return { start, end, text, selectionStart: start + text.length, selectionEnd: start + text.length };
}

/** Tab: 選んだ行（カーソルのある行）がすべて一覧の項目のときだけ字下げする。Shift+Tab は字下げを戻す。動かせないときは null（フォーカスを移す）。 */
export function indentListEdit(value: string, start: number, end: number, outdent: boolean): AssistEdit | null {
  const first = lineBounds(value, start);
  // 範囲が行頭で終わるときは、その行を含めない
  const last = lineBounds(value, end > start && value.charAt(end - 1) === '\n' ? end - 1 : end);
  const lines: ListLine[] = [];
  for (let at = first.start; at <= last.start;) {
    const line = listLine(value, at);
    if (line === null || inFence(value, line.start)) return null;
    lines.push(line);
    at = line.end + 1;
  }
  const head = lines[0];
  if (head === undefined) return null;
  const parent = previousParent(value, head.start, outdent ? head.indent.length - 1 : head.indent.length);
  // 戻す量は、親の字下げまで（親が無ければ行頭まで）。足す量は、親の中身が始まる桁まで。親が無い（一覧の先頭の項目）なら足さず、Tab はフォーカスを移す
  const delta = outdent
    ? Math.min(head.indent.length, head.indent.length - (parent?.indent.length ?? 0))
    : parent === null
      ? 0
      : markWidth(parent.mark) + parent.indent.length - head.indent.length;
  if (delta <= 0) return null;
  const changes = lines.map((line) => ({ line, delta: outdent ? -Math.min(delta, line.indent.length) : delta }));
  const text = changes
    .map(({ line, delta: change }) =>
      change >= 0
        ? ' '.repeat(change) + line.indent + line.mark + line.content
        : value.slice(line.start - change, line.end),
    )
    .join('\n');
  const blockStart = head.start;
  const blockEnd = lines[lines.length - 1]?.end ?? blockStart;
  const old = value.slice(blockStart, blockEnd);
  if (text === old) return null;
  // 書き換えは変わる範囲だけにする（行全体を置き換えると、アップロード中のファイルの位置と入れた画像の追跡が外れる）
  let prefix = 0;
  while (prefix < old.length && prefix < text.length && old[prefix] === text[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < old.length - prefix &&
    suffix < text.length - prefix &&
    old[old.length - 1 - suffix] === text[text.length - 1 - suffix]
  )
    suffix++;
  const from = blockStart + prefix;
  const to = blockEnd - suffix;
  const replacement = text.slice(prefix, text.length - suffix);
  // 位置の移し方: 字下げは行頭より後ろの位置が動く（カーソルだけなら行頭も動く）。戻すときは消えた空白の中の位置が行頭に寄る
  const move = (position: number): number => {
    let shift = 0;
    for (const { line, delta: change } of changes) {
      if (change > 0 && (position > line.start || (position === line.start && start === end))) shift += change;
      else if (change < 0 && position > line.start) shift += Math.max(change, line.start - position);
    }
    return position + shift;
  };
  return { start: from, end: to, text: replacement, selectionStart: move(start), selectionEnd: move(end) };
}

// 貼ったのが、リンクにできる URL 1つだけか。http と https の絶対 URL で、空白と改行を含まない（画面のリンクの規則に合わせる）
export function pastedLink(pasted: string): string | null {
  const url = pasted.trim();
  // `https:example.com` のような「//」の無い綴りは、new URL は通すが画面は文字のままにするので、先に落とす
  if (url === '' || url.length > MAX_URL_LENGTH || !/^https?:\/\//iu.test(url) || /[\s<>\\]/u.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.href.length > MAX_URL_LENGTH
    )
      return null;
  } catch {
    return null;
  }
  return url;
}

/** URL の貼り付け: 文字を選んでいて、貼るのが URL 1つだけのときに、選んだ文字をリンクの文字にする。 */
export function linkPasteEdit(value: string, start: number, end: number, pasted: string): AssistEdit | null {
  const url = pastedLink(pasted);
  const selected = value.slice(start, end);
  // コードの囲みの中は、書式を足すとコードが壊れるので補助しない
  if (inFence(value, lineBounds(value, start).start)) return null;
  // 選んだ文字に `\` があるときは、すでにあるエスケープの意味が変わりうるので補助しない
  if (url === null || start === end || /[\n\\]/u.test(selected) || selected.trim() === '') return null;
  const label = selected.replace(/[[\]]/gu, '\\$&');
  // 括弧を含む URL は <> で囲む（閉じの括弧でリンクが切れないため）
  const destination = /[()]/u.test(url) ? `<${url}>` : url;
  const text = `[${label}](${destination})`;
  return { start, end, text, selectionStart: start + text.length, selectionEnd: start + text.length };
}

/**
 * 欄の keydown に対する補助。変換中（`composing`、`isComposing`、`keyCode` 229）と修飾キー付き（Shift+Tab を除く）は何もしない。
 * Tab は一覧の中だけで奪い、一覧の外ではフォーカスの移りに任せる。
 */
export function assistKeyEdit(
  event: AssistKey,
  composing: boolean,
  value: string,
  start: number,
  end: number,
): AssistEdit | null {
  if (composing || event.isComposing || event.keyCode === 229) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === 'Enter' && !event.shiftKey) return continueListEdit(value, start, end);
  if (event.key === 'Tab') return indentListEdit(value, start, end, event.shiftKey);
  return null;
}
