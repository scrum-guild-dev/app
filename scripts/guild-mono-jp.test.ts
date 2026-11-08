// design/fonts/ の Guild Mono JP（scripts/guild-mono-jp.py の生成物）が、CSS と実ファイルで食い違わず、
// OFL の予約フォント名「PlemolJP」を名乗らず、ライセンスを同梱していることを確かめる
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { brotliDecompressSync } from 'node:zlib';

const fontsDir = new URL('../design/fonts/', import.meta.url);
const css = readFileSync(new URL('guild-mono-jp.css', fontsDir), 'utf8');
const faces = css.split('@font-face').slice(1);

function ranges(face: string): [number, number][] {
  const value = /unicode-range:\s*([^;]+);/.exec(face)?.[1] ?? '';
  return value.split(',').map((part) => {
    const [start, end = start] = part.trim().replace(/^U\+/i, '').split('-');
    return [parseInt(start ?? '', 16), parseInt(end ?? '', 16)];
  });
}

// WOFF2 の UIntBase128（可変長の整数）を読み、値と次の位置を返す
function readBase128(buf: Buffer, pos: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buf[pos + i] ?? 0;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, pos + i + 1];
  }
  throw new Error('UIntBase128 が 5 バイトを超えた');
}

// woff2 の name の表から、name ID と文字列の組を読む。name の表は WOFF2 で変換されないので、
// 圧縮を解いた後、表の一覧の順に長さを足した位置にそのまま入っている
function nameRecords(file: URL): { nameId: number; text: string }[] {
  const buf = readFileSync(file);
  assert.equal(buf.toString('latin1', 0, 4), 'wOF2', `${file.pathname} が woff2 でない`);
  const numTables = buf.readUInt16BE(12);
  const NAME = 5; // WOFF2 の既知の表の番号で name
  const [GLYF, LOCA, HMTX] = [10, 11, 3];
  let pos = 48;
  let offset = 0;
  let name: { offset: number; length: number } | undefined;
  for (let i = 0; i < numTables; i++) {
    const flags = buf[pos++] ?? 0;
    const tagIndex = flags & 0x3f;
    if (tagIndex === 63) pos += 4;
    const transform = (flags >> 6) & 3;
    let length: number;
    [length, pos] = readBase128(buf, pos);
    const transformed =
      ((tagIndex === GLYF || tagIndex === LOCA) && transform === 0) || (tagIndex === HMTX && transform === 1);
    if (transformed) [length, pos] = readBase128(buf, pos);
    if (tagIndex === NAME) name = { offset, length };
    offset += length;
  }
  assert.ok(name, `${file.pathname} に name の表が無い`);
  const table = brotliDecompressSync(buf.subarray(pos)).subarray(name.offset, name.offset + name.length);
  const count = table.readUInt16BE(2);
  const stringOffset = table.readUInt16BE(4);
  return Array.from({ length: count }, (_, i) => {
    const at = 6 + i * 12;
    const platform = table.readUInt16BE(at);
    const start = stringOffset + table.readUInt16BE(at + 10);
    const raw = table.subarray(start, start + table.readUInt16BE(at + 8));
    // Windows（3）と Unicode（0）は UTF-16BE、Macintosh（1）は 1 バイトの文字
    const text = platform === 1 ? raw.toString('latin1') : Buffer.from(raw).swap16().toString('utf16le');
    return { nameId: table.readUInt16BE(at + 6), text };
  });
}

describe('Guild Mono JP の生成物', () => {
  test('400 と 700 の @font-face があり、どれも Guild Mono JP の woff2 を swap で読む', () => {
    assert.ok(faces.length > 0);
    const weights = new Set<string>();
    for (const face of faces) {
      assert.match(face, /font-family: 'Guild Mono JP';/);
      assert.match(face, /font-display: swap;/);
      assert.match(face, /format\('woff2'\)/);
      weights.add(/font-weight: (\d+);/.exec(face)?.[1] ?? '');
    }
    assert.deepEqual([...weights].sort(), ['400', '700']);
  });

  test('CSS の url と design/fonts/guild-mono-jp/ の woff2 が過不足なく対応する', () => {
    const urls = faces.map((face) => /url\('\.\/guild-mono-jp\/([^']+)'\)/.exec(face)?.[1]);
    assert.ok(urls.every((name) => name !== undefined));
    const files = readdirSync(new URL('guild-mono-jp/', fontsDir)).filter((name) => name.endsWith('.woff2'));
    assert.deepEqual([...urls].sort(), files.sort());
  });

  test('CSS の font-family に予約フォント名を使わず、ライセンスを同梱する', () => {
    assert.doesNotMatch(css, /font-family:[^;]*PlemolJP/i);
    const license = new URL('guild-mono-jp/OFL.txt', fontsDir);
    assert.ok(existsSync(license));
    assert.match(readFileSync(license, 'utf8'), /Reserved Font Name "PlemolJP"/);
  });

  test('どの woff2 も、name の表で Guild Mono JP を名乗り、著作権とライセンスの欄のほかに予約名を残さない', () => {
    // 著作権（0）とライセンス（13、14）の欄は、元の書体の名前を書いてよい
    const allowed = new Set([0, 13, 14]);
    const files = readdirSync(new URL('guild-mono-jp/', fontsDir)).filter((name) => name.endsWith('.woff2'));
    assert.ok(files.length > 0);
    for (const name of files) {
      const records = nameRecords(new URL(`guild-mono-jp/${name}`, fontsDir));
      assert.ok(
        records.some((r) => r.nameId === 1 && r.text === 'Guild Mono JP'),
        `${name} の name ID 1 が Guild Mono JP でない`,
      );
      for (const r of records) {
        if (allowed.has(r.nameId)) continue;
        assert.doesNotMatch(r.text, /plemol\s*jp/i, `${name} の name ID ${r.nameId} に予約名が残る`);
      }
    }
  });

  test('全角の空白（U+3000）はどの範囲にも入れない', () => {
    // PlemolJP は全角の空白を点線の四角で描くので、端末の書体の空白で組ませる
    for (const face of faces) {
      for (const [start, end] of ranges(face)) {
        assert.ok(!(start <= 0x3000 && 0x3000 <= end), `U+3000 が ${start.toString(16)}-${end.toString(16)} に入る`);
      }
    }
  });
});
