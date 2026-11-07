import { describe, expect, test } from 'vitest';
import {
  assistKeyEdit,
  continueListEdit,
  indentListEdit,
  linkPasteEdit,
  pastedLink,
  type AssistEdit,
  type AssistKey,
} from './markdown-assist.ts';

const run = (value: string, edit: AssistEdit | null) =>
  edit === null
    ? null
    : {
        value: value.slice(0, edit.start) + edit.text + value.slice(edit.end),
        selection: [edit.selectionStart, edit.selectionEnd],
      };

// 「|」をカーソル、「«」と「»」を選択の範囲として、書き換えた本文（同じ記法）を返す
function mark(value: string, edit: AssistEdit | null): string | null {
  const result = run(value, edit);
  if (result === null) return null;
  const [from = 0, to = 0] = result.selection;
  return from === to
    ? `${result.value.slice(0, from)}|${result.value.slice(from)}`
    : `${result.value.slice(0, from)}«${result.value.slice(from, to)}»${result.value.slice(to)}`;
}

function at(source: string): { value: string; start: number; end: number } {
  const open = source.indexOf('«');
  const close = source.indexOf('»');
  if (open !== -1 && close !== -1) {
    const value = source.slice(0, open) + source.slice(open + 1, close) + source.slice(close + 1);
    return { value, start: open, end: close - 1 };
  }
  const caret = source.indexOf('|');
  return { value: source.replace('|', ''), start: caret, end: caret };
}

const enter = (source: string) => {
  const { value, start, end } = at(source);
  return mark(value, continueListEdit(value, start, end));
};
const tab = (source: string, outdent = false) => {
  const { value, start, end } = at(source);
  return mark(value, indentListEdit(value, start, end, outdent));
};

describe('Enter でリストを続ける', () => {
  test('箇条書きは同じ印を足す', () => {
    expect(enter('- あ|')).toBe('- あ\n- |');
    expect(enter('* あ|')).toBe('* あ\n* |');
    expect(enter('+ あ|')).toBe('+ あ\n+ |');
  });

  test('番号付きの一覧は次の番号を足す', () => {
    expect(enter('1. あ|')).toBe('1. あ\n2. |');
    expect(enter('9. あ|')).toBe('9. あ\n10. |');
    expect(enter('3) あ|')).toBe('3) あ\n4) |');
  });

  test('チェックリストは、済みの項目でも未完了の箱を足す', () => {
    expect(enter('- [ ] あ|')).toBe('- [ ] あ\n- [ ] |');
    expect(enter('- [x] あ|')).toBe('- [x] あ\n- [ ] |');
    expect(enter('- [X] あ|')).toBe('- [X] あ\n- [ ] |');
  });

  test('字下げは引き継ぐ', () => {
    expect(enter('- あ\n  - い|')).toBe('- あ\n  - い\n  - |');
    expect(enter('\t- あ|')).toBe('\t- あ\n\t- |');
  });

  test('前後の行はそのまま', () => {
    expect(enter('前\n- あ|\n後')).toBe('前\n- あ\n- |\n後');
  });

  test('空の項目では印を消して一覧を抜ける', () => {
    expect(enter('- あ\n- |')).toBe('- あ\n|');
    expect(enter('1. あ\n2. |')).toBe('1. あ\n|');
    expect(enter('- [ ] |')).toBe('|');
    expect(enter('- あ\n  - |')).toBe('- あ\n|');
    expect(enter('- あ\n-   |')).toBe('- あ\n|');
  });

  test('カーソルの後ろに文字があるとき、範囲を選んでいるときは普通の改行に任せる', () => {
    expect(enter('- あ|い')).toBeNull();
    expect(enter('-| あ')).toBeNull();
    expect(enter('- «あ»')).toBeNull();
  });

  test('区切り線は一覧として扱わない', () => {
    expect(enter('- - -|')).toBeNull();
    expect(enter('* * *|')).toBeNull();
    expect(enter('***|')).toBeNull();
  });

  test('一覧でない行、印の後ろに空白が無い行は何もしない', () => {
    expect(enter('あ|')).toBeNull();
    expect(enter('-あ|')).toBeNull();
    expect(enter('---|')).toBeNull();
    expect(enter('**太字**|')).toBeNull();
    expect(enter('> 引用|')).toBeNull();
    expect(enter('|')).toBeNull();
  });

  test('囲みの種類と長さを見て、囲みの外の項目は続け、中は続けない', () => {
    expect(enter('~~~\n```\n~~~\n- あ|')).toBe('~~~\n```\n~~~\n- あ\n- |');
    expect(enter('````\n```\n- あ|\n```\n````')).toBeNull();
    expect(enter('```js code```\n- あ|')).toBe('```js code```\n- あ\n- |');
    expect(enter('```\n- あ\n```\n- い|\n```\nコード\n```')).toBe('```\n- あ\n```\n- い\n- |\n```\nコード\n```');
  });

  test('番号が10桁になるときは普通の改行に任せ、U+2028 を含む行も項目として読む', () => {
    expect(enter('999999999. あ|')).toBeNull();
    expect(enter('- あ\u2028い|')).toBe('- あ\u2028い\n- |');
  });

  test('コードの囲みの中では続けない', () => {
    expect(enter('```\n- あ|\n```')).toBeNull();
    expect(enter('```\n- あ\n```\n- い|')).toBe('```\n- あ\n```\n- い\n- |');
  });
});

describe('Tab と Shift+Tab で字下げする', () => {
  test('一覧の項目は、親の中身が始まる桁まで字下げする', () => {
    expect(tab('- あ\n- い|')).toBe('- あ\n  - い|');
    expect(tab('1. あ\n- い|')).toBe('1. あ\n   - い|');
    expect(tab('10. あ\n- い|')).toBe('10. あ\n    - い|');
    expect(tab('- あ\n- [ ] い|')).toBe('- あ\n  - [ ] い|');
  });

  test('すでに入れ子の項目は、同じ階層の直前の項目の下に入れる', () => {
    expect(tab('- あ\n  - い\n  - う|')).toBe('- あ\n  - い\n    - う|');
  });

  test('親が無い（一覧の先頭の）項目は字下げせず、フォーカスを移す', () => {
    expect(tab('- あ|')).toBeNull();
    expect(tab('段落\n- あ|')).toBeNull();
    expect(tab('- あ\n\n- い|')).toBeNull();
  });

  test('続けて押しても字下げは増え続けず、入れ子の次の Tab ではフォーカスを移す', () => {
    expect(tab('- あ\n- い|')).toBe('- あ\n  - い|');
    expect(tab('- あ\n  - い|')).toBeNull();
  });

  test('空の最初の行にカーソルがあるとき、次の行を字下げしない', () => {
    expect(tab('|\n- あ')).toBeNull();
    expect(tab('|\n- あ\n- い')).toBeNull();
  });

  test('書き換えは変わる範囲（行頭の空白）だけにする', () => {
    const value = '- あ\n- い ![x](/api/a/attachments/1)';
    const edit = indentListEdit(value, value.length, value.length, false);
    expect(edit).toMatchObject({ start: 4, end: 4, text: '  ' });
  });

  test('カーソルが行頭でも項目の前の字下げの後ろに動く', () => {
    expect(tab('- あ\n|- い')).toBe('- あ\n  |- い');
  });

  test('Shift+Tab は親の字下げまで戻す', () => {
    expect(tab('- あ\n  - い|', true)).toBe('- あ\n- い|');
    expect(tab('1. あ\n   - い|', true)).toBe('1. あ\n- い|');
    expect(tab('- あ\n  - い\n    - う|', true)).toBe('- あ\n  - い\n  - う|');
  });

  test('戻せない（字下げが無い）ときは何もしない（フォーカスを移す）', () => {
    expect(tab('- あ|', true)).toBeNull();
  });

  test('複数の行を選んでいれば、まとめて動かす', () => {
    expect(tab('- あ\n«- い\n- う»')).toBe('- あ\n«  - い\n  - う»');
    expect(tab('- あ\n  «- い\n  - う»', true)).toBe('- あ\n«- い\n- う»');
  });

  test('範囲が次の行の行頭で終わるとき、その行は含めない', () => {
    expect(tab('- あ\n«- い\n»- う')).toBe('- あ\n«  - い\n»- う');
  });

  test('一覧でない行を含むとき、一覧の外では何もしない（フォーカスを移す）', () => {
    expect(tab('あ|')).toBeNull();
    expect(tab('- あ\n«い\n- う»')).toBeNull();
    expect(tab('|')).toBeNull();
    expect(tab('あ|', true)).toBeNull();
  });

  test('コードの囲みの中では動かさない', () => {
    expect(tab('```\n- あ|\n```')).toBeNull();
  });

  test('空の項目も字下げできる', () => {
    expect(tab('- あ\n- |')).toBe('- あ\n  - |');
  });
});

describe('選んだ文字に URL を貼ってリンクにする', () => {
  const paste = (source: string, pasted: string) => {
    const { value, start, end } = at(source);
    return mark(value, linkPasteEdit(value, start, end, pasted));
  };

  test('文字を選んで URL を1つ貼ると、リンクの文字にする', () => {
    expect(paste('詳しくは«ここ»を見て', 'https://example.com/a')).toBe('詳しくは[ここ](https://example.com/a)|を見て');
  });

  test('前後の空白と末尾の改行は取る', () => {
    expect(paste('«あ»', ' https://example.com\n')).toBe('[あ](https://example.com)|');
  });

  test('リンクの文字の中の記号はエスケープし、括弧のある URL は <> で囲む', () => {
    expect(paste('«a[1]b»', 'https://example.com/')).toBe('[a\\[1\\]b](https://example.com/)|');
    expect(paste('«あ»', 'https://example.com/a_(b)')).toBe('[あ](<https://example.com/a_(b)>)|');
  });

  test('選んだ文字にバックスラッシュがあるときは貼り付けに任せる', () => {
    expect(paste('«a\\b»', 'https://example.com/')).toBeNull();
  });

  test('コードの囲みの中を選んだときと、バックスラッシュを含む URL は貼り付けに任せる', () => {
    expect(paste('```\n«foo»\n```', 'https://example.com/')).toBeNull();
    expect(pastedLink('https://example.com/a\\*')).toBeNull();
  });

  test('選んでいないとき、複数行を選んだとき、空白だけを選んだときは貼り付けに任せる', () => {
    expect(paste('あ|', 'https://example.com')).toBeNull();
    expect(paste('«あ\nい»', 'https://example.com')).toBeNull();
    expect(paste('« »', 'https://example.com')).toBeNull();
  });

  test('URL でないもの、複数あるもの、http と https 以外は貼り付けに任せる', () => {
    expect(paste('«あ»', 'こんにちは')).toBeNull();
    expect(paste('«あ»', 'example.com')).toBeNull();
    expect(paste('«あ»', 'https://example.com https://example.org')).toBeNull();
    expect(paste('«あ»', 'https://example.com\nhttps://example.org')).toBeNull();
    expect(paste('«あ»', 'javascript:alert(1)')).toBeNull();
    expect(paste('«あ»', 'mailto:a@example.com')).toBeNull();
    expect(paste('«あ»', 'data:text/plain,a')).toBeNull();
    expect(paste('«あ»', '/relative')).toBeNull();
    expect(paste('«あ»', '')).toBeNull();
  });

  test('画面でリンクにならない URL（ユーザー情報つき、長すぎる、<> を含む）はリンクにしない', () => {
    expect(pastedLink('https://user@example.com/')).toBeNull();
    expect(pastedLink('https://user:pass@example.com/')).toBeNull();
    expect(pastedLink(`https://example.com/${'a'.repeat(2048)}`)).toBeNull();
    expect(pastedLink('https://example.com/<a>')).toBeNull();
    expect(pastedLink('https://example.com/')).toBe('https://example.com/');
    // 画面は「//」の無い綴りと、正規化した後の長さが上限を超える URL を文字のままにする
    expect(pastedLink('https:example.com')).toBeNull();
    expect(pastedLink('http:example.com')).toBeNull();
    expect(pastedLink(`https://example.com/${'あ'.repeat(300)}`)).toBeNull();
  });
});

describe('キーの条件', () => {
  const key = (override: Partial<AssistKey>): AssistKey => ({
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 13,
    ...override,
  });
  const press = (event: AssistKey, source: string, composing = false) => {
    const { value, start, end } = at(source);
    return mark(value, assistKeyEdit(event, composing, value, start, end));
  };

  test('Enter はリストを続け、Tab と Shift+Tab は字下げする', () => {
    expect(press(key({}), '- あ|')).toBe('- あ\n- |');
    expect(press(key({ key: 'Tab', keyCode: 9 }), '- あ\n- い|')).toBe('- あ\n  - い|');
    expect(press(key({ key: 'Tab', keyCode: 9, shiftKey: true }), '- あ\n  - い|')).toBe('- あ\n- い|');
  });

  test('日本語の変換中は動かない（composing、isComposing、keyCode 229のどれでも）', () => {
    expect(press(key({}), '- あ|', true)).toBeNull();
    expect(press(key({ isComposing: true }), '- あ|')).toBeNull();
    expect(press(key({ keyCode: 229 }), '- あ|')).toBeNull();
    expect(press(key({ key: 'Tab', keyCode: 9, isComposing: true }), '- あ\n- い|')).toBeNull();
  });

  test('Shift、Ctrl、Alt、Meta を押した Enter は普通の改行などに任せる', () => {
    expect(press(key({ shiftKey: true }), '- あ|')).toBeNull();
    expect(press(key({ ctrlKey: true }), '- あ|')).toBeNull();
    expect(press(key({ metaKey: true }), '- あ|')).toBeNull();
    expect(press(key({ altKey: true }), '- あ|')).toBeNull();
    expect(press(key({ key: 'Tab', keyCode: 9, ctrlKey: true }), '- あ\n- い|')).toBeNull();
    expect(press(key({ key: 'Tab', keyCode: 9, altKey: true }), '- あ\n- い|')).toBeNull();
  });

  test('ほかのキーは何もしない', () => {
    expect(press(key({ key: 'a', keyCode: 65 }), '- あ|')).toBeNull();
    expect(press(key({ key: 'Escape', keyCode: 27 }), '- あ|')).toBeNull();
  });
});
