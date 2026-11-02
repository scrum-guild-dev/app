// 添付ファイルの種類を、中身の先頭のバイト（最大 64 バイト）で決める（docs/development.md の「添付ファイルの配信」）
export function sniffContentType(head: Uint8Array): string {
  head = head.subarray(0, 64);
  if (matches(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (matches(head, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(head, 0, 'GIF87a') || ascii(head, 0, 'GIF89a')) return 'image/gif';
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return 'image/webp';
  if (ascii(head, 4, 'ftyp') && MP4_BRANDS.some((brand) => ascii(head, 8, brand))) return 'video/mp4';
  if (matches(head, 0, [0x1a, 0x45, 0xdf, 0xa3]) && hasWebmDocType(head)) return 'video/webm';
  return 'application/octet-stream';
}

const MP4_BRANDS = ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V '];

function matches(head: Uint8Array, offset: number, bytes: readonly number[]): boolean {
  return offset + bytes.length <= head.length && bytes.every((byte, index) => head[offset + index] === byte);
}

function ascii(head: Uint8Array, offset: number, text: string): boolean {
  return matches(
    head,
    offset,
    Array.from(text, (character) => character.charCodeAt(0)),
  );
}

// EBML の可変長整数。ID は先頭の長さの印を残し、サイズは印を除く。
function vint(head: Uint8Array, offset: number, id = false): { value: number; length: number } | undefined {
  const first = head[offset];
  if (first === undefined || first === 0) return undefined;
  let length = 1;
  let marker = 0x80;
  while ((first & marker) === 0) {
    length++;
    marker >>= 1;
  }
  if (length > (id ? 4 : 8) || offset + length > head.length) return undefined;
  let value = id ? first : first & (marker - 1);
  for (let i = 1; i < length; i++) value = value * 256 + head[offset + i]!;
  // サイズが不明の印と、安全に表せない大きさは判定しない。
  if (!Number.isSafeInteger(value) || (!id && value === 2 ** (7 * length) - 1)) return undefined;
  return { value, length };
}

function hasWebmDocType(head: Uint8Array): boolean {
  const headerSize = vint(head, 4);
  if (headerSize === undefined) return false;
  let offset = 4 + headerSize.length;
  const end = Math.min(head.length, offset + headerSize.value);
  while (offset < end) {
    const id = vint(head.subarray(0, end), offset, true);
    if (id === undefined) return false;
    offset += id.length;
    const size = vint(head.subarray(0, end), offset);
    if (size === undefined) return false;
    offset += size.length;
    if (offset + size.value > end) return false;
    if (id.value === 0x4282) return size.value === 4 && ascii(head, offset, 'webm');
    offset += size.value;
  }
  return false;
}
