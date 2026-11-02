// 添付ファイルの種類を先頭のバイトで決める（src/server/attachments/sniff.ts。Issue #744 の前提の行）。
// 画面で見せる画像4種と動画2種だけを名前で返し、同じ箱の形の兄弟の形式（HEIC、AVIF、QuickTime、Matroska）と、
// 拡張子や申告の型を偽った中身は application/octet-stream にする
import { describe, expect, test } from 'vitest';
import { sniffContentType } from '../src/server/attachments/sniff.ts';

const OCTET = 'application/octet-stream';

// 数（バイト）と文字列（ASCII）を並べて1つのバイト列にする
function bytes(...parts: (number | string | number[])[]): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'number') out.push(part);
    else if (typeof part === 'string') for (const ch of part) out.push(ch.charCodeAt(0));
    else out.push(...part);
  }
  return new Uint8Array(out);
}

// 64 バイトまで 0 で埋める（判定に使う先頭の長さの上限）
function padTo64(head: Uint8Array): Uint8Array {
  const out = new Uint8Array(64);
  out.set(head.subarray(0, 64));
  return out;
}

const text = (value: string) => new TextEncoder().encode(value);

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff);
// RIFF、長さ（4バイト）、WEBP
const webp = (form = 'WEBP') => bytes('RIFF', [0x24, 0, 0, 0], form);
// 箱の長さ（4バイト）、ftyp、major brand、minor version
const ftyp = (brand: string) => bytes([0, 0, 0, 0x18], 'ftyp', brand, [0, 0, 0, 0]);
// EBML のヘッダー: EBMLVersion、EBMLReadVersion、EBMLMaxIDLength、EBMLMaxSizeLength、DocType、DocTypeVersion、DocTypeReadVersion
function ebml(docType: string): Uint8Array {
  const docTypeElement = bytes([0x42, 0x82, 0x80 | docType.length], docType);
  const body = bytes(
    [0x42, 0x86, 0x81, 0x01],
    [0x42, 0xf7, 0x81, 0x01],
    [0x42, 0xf2, 0x81, 0x04],
    [0x42, 0xf3, 0x81, 0x08],
    [...docTypeElement],
    [0x42, 0x87, 0x81, 0x04],
    [0x42, 0x85, 0x81, 0x02],
  );
  return bytes([0x1a, 0x45, 0xdf, 0xa3, 0x80 | body.length], [...body]);
}

describe('画面で見せる種類は、正しい先頭で名前を返す', () => {
  test.each([
    ['PNG', PNG, 'image/png'],
    ['JPEG（JFIF）', bytes([...JPEG], 0xe0, 0x00, 0x10, 'JFIF'), 'image/jpeg'],
    ['JPEG（Exif）', bytes([...JPEG], 0xe1, 0x00, 0x10, 'Exif'), 'image/jpeg'],
    ['GIF87a', bytes('GIF87a', 0x01, 0x00), 'image/gif'],
    ['GIF89a', bytes('GIF89a', 0x01, 0x00), 'image/gif'],
    ['WebP', webp(), 'image/webp'],
    ['WebM', ebml('webm'), 'video/webm'],
  ])('%s', (_label, head, expected) => {
    expect(sniffContentType(head)).toBe(expected);
    // 64 バイトまで続きがあっても同じ
    expect(sniffContentType(padTo64(head))).toBe(expected);
  });

  test.each(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V '])(
    'MP4 の major brand %j は video/mp4',
    (brand) => {
      expect(sniffContentType(ftyp(brand))).toBe('video/mp4');
      expect(sniffContentType(padTo64(ftyp(brand)))).toBe('video/mp4');
    },
  );

  test('ftyp の箱の長さ（先頭の4バイト）によらず、4バイト目からの ftyp で決める', () => {
    expect(sniffContentType(bytes([0, 0, 0, 0x20], 'ftyp', 'isom', [0, 0, 2, 0], 'isomiso2'))).toBe('video/mp4');
    expect(sniffContentType(bytes([0, 0, 0, 0x1c], 'ftyp', 'mp42'))).toBe('video/mp4');
  });
});

describe('拡張子や申告の型を偽った中身は application/octet-stream', () => {
  test.each([
    ['テキスト', text('これは画像ではない。ただの文章')],
    ['英字のテキスト', text('hello.png is actually text')],
    ['HTML', text('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>')],
    ['小文字の HTML', text('<html><head><title>x</title></head></html>')],
    ['SVG', text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')],
    ['XML の宣言付きの SVG', text('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['BOM 付きのテキスト', bytes(0xef, 0xbb, 0xbf, 'GIF89a')],
    ['JSON', text('{"type":"image/png"}')],
    ['PDF', text('%PDF-1.7\n')],
    ['ZIP', bytes('PK', 0x03, 0x04, 0x14, 0x00)],
  ])('%s', (_label, head) => {
    expect(sniffContentType(head)).toBe(OCTET);
  });

  test('印の前に1バイトでもあれば、その形式としない（先頭からの一致だけを見る）', () => {
    expect(sniffContentType(bytes(0x00, [...PNG]))).toBe(OCTET);
    expect(sniffContentType(bytes(' ', 'GIF89a'))).toBe(OCTET);
    expect(sniffContentType(bytes(0x00, [...JPEG]))).toBe(OCTET);
    expect(sniffContentType(bytes(0x00, [...ebml('webm')]))).toBe(OCTET);
  });

  test('印の1バイトが違えば、その形式としない', () => {
    expect(sniffContentType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b))).toBe(OCTET);
    expect(sniffContentType(bytes(0xff, 0xd8, 0xfe))).toBe(OCTET);
    expect(sniffContentType(bytes('GIF88a'))).toBe(OCTET);
    expect(sniffContentType(bytes('gif89a'))).toBe(OCTET);
    expect(sniffContentType(bytes('RIFX', [0x24, 0, 0, 0], 'WEBP'))).toBe(OCTET);
    expect(sniffContentType(bytes([0x1a, 0x45, 0xdf, 0xa4], [...ebml('webm').subarray(4)]))).toBe(OCTET);
  });
});

describe('同じ箱の形を持つ兄弟の形式は application/octet-stream', () => {
  test.each(['heic', 'heix', 'mif1', 'avif', 'avis', 'qt  ', 'M4A ', 'iso3', 'ISOM', 'mp43', '3gp4'])(
    'ftyp の major brand %j',
    (brand) => {
      expect(sniffContentType(ftyp(brand))).toBe(OCTET);
      expect(sniffContentType(padTo64(ftyp(brand)))).toBe(OCTET);
    },
  );

  test('RIFF でも WEBP でない形式（WAVE、AVI）', () => {
    expect(sniffContentType(webp('WAVE'))).toBe(OCTET);
    expect(sniffContentType(webp('AVI '))).toBe(OCTET);
  });

  test('EBML の DocType が matroska', () => {
    expect(sniffContentType(ebml('matroska'))).toBe(OCTET);
    expect(sniffContentType(padTo64(ebml('matroska')))).toBe(OCTET);
  });

  test('EBML の DocType が webm に似た別の値', () => {
    expect(sniffContentType(ebml('webmx'))).toBe(OCTET);
    expect(sniffContentType(ebml('web'))).toBe(OCTET);
    expect(sniffContentType(ebml('WEBM'))).toBe(OCTET);
  });

  test('EBML の印の後に DocType の要素が無ければ、webm の文字があっても video/webm にしない', () => {
    // DocType の ID（42 82）を持たず、ほかの要素の値として webm の4文字を置く
    const head = bytes([0x1a, 0x45, 0xdf, 0xa3, 0x8b], [0x42, 0x86, 0x81, 0x01], [0x42, 0x87, 0x84], 'webm');
    expect(sniffContentType(head)).toBe(OCTET);
    expect(sniffContentType(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x84], [0x42, 0x86, 0x81, 0x01]))).toBe(OCTET);
  });

  test('ftyp が4バイト目でなければ MP4 にしない', () => {
    expect(sniffContentType(bytes([0, 0, 0x18], 'ftyp', 'isom'))).toBe(OCTET);
    expect(sniffContentType(bytes('ftyp', 'isom', [0, 0, 0, 0]))).toBe(OCTET);
  });
});

describe('長さの境界', () => {
  test('空は application/octet-stream', () => {
    expect(sniffContentType(new Uint8Array(0))).toBe(OCTET);
  });

  test('印にちょうど足りる長さなら、その形式', () => {
    expect(sniffContentType(PNG)).toBe('image/png');
    expect(sniffContentType(JPEG)).toBe('image/jpeg');
    expect(sniffContentType(bytes('GIF89a'))).toBe('image/gif');
    expect(sniffContentType(webp())).toBe('image/webp');
    // 箱の長さ、ftyp、major brand の12バイト
    expect(sniffContentType(bytes([0, 0, 0, 0x0c], 'ftyp', 'isom'))).toBe('video/mp4');
  });

  test('印に1バイト足りなければ application/octet-stream', () => {
    expect(sniffContentType(PNG.subarray(0, 7))).toBe(OCTET);
    expect(sniffContentType(JPEG.subarray(0, 2))).toBe(OCTET);
    expect(sniffContentType(bytes('GIF89'))).toBe(OCTET);
    expect(sniffContentType(webp().subarray(0, 11))).toBe(OCTET);
    expect(sniffContentType(bytes([0, 0, 0, 0x0c], 'ftyp', 'iso'))).toBe(OCTET);
    expect(sniffContentType(bytes([0x1a, 0x45, 0xdf]))).toBe(OCTET);
  });

  test('EBML の印だけで DocType まで届かない短さは application/octet-stream', () => {
    const full = ebml('webm');
    // DocType の値の最後の1バイトを欠く
    const docTypeEnd = full.indexOf(0x6d, full.indexOf(0x82)) + 1;
    expect(sniffContentType(full.subarray(0, docTypeEnd))).toBe('video/webm');
    expect(sniffContentType(full.subarray(0, docTypeEnd - 1))).toBe(OCTET);
    expect(sniffContentType(bytes([0x1a, 0x45, 0xdf, 0xa3]))).toBe(OCTET);
  });

  test('1バイトの入力は application/octet-stream', () => {
    expect(sniffContentType(bytes(0x89))).toBe(OCTET);
    expect(sniffContentType(bytes(0xff))).toBe(OCTET);
  });
});
