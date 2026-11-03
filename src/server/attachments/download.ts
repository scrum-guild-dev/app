// R2 の本文は読み切らず Response へ渡す。型とファイル名は検証して保存した D1 の値を使う。
import { errorBody } from '../errors.ts';

const inlineTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm']);

type ByteRange = { offset: number; length: number };

// undefined は無視できる未知の単位、null は不正または満たせない bytes 範囲。
// 一度に1範囲だけを受ける。複数範囲を組み立てて本文をメモリに集めない。
function byteRange(value: string, size: number): ByteRange | null | undefined {
  const equal = value.indexOf('=');
  const unit = (equal === -1 ? value : value.slice(0, equal)).trim().toLowerCase();
  if (unit !== 'bytes') return undefined;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (match === null || (match[1] === '' && match[2] === '') || size === 0) return null;
  if (match[1] === '') {
    const length = Math.min(Number(match[2]), size);
    return length > 0 ? { offset: size - length, length } : null;
  }
  const offset = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (offset >= size || end < offset) return null;
  return { offset, length: end - offset + 1 };
}

function contentDisposition(name: string, inline: boolean): string {
  // ASCII の代替名にはパスの区切りやパラメータの記号を入れず、元の名前は filename* にだけ載せる。
  let fallback = [...name]
    .map((char) => {
      const code = char.codePointAt(0)!;
      return code >= 0x20 && code < 0x7f && !'"\\/%;:'.includes(char) ? char : '_';
    })
    .join('')
    .trim();
  if (fallback === '' || fallback === '.' || fallback === '..') fallback = 'download';
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function downloadAttachment(
  bucket: R2Bucket,
  file: { object_key: string; content_type: string; file_name: string },
  request: { range: string | undefined; ifRange: string | undefined; head: boolean },
): Promise<Response | null> {
  const video = file.content_type === 'video/mp4' || file.content_type === 'video/webm';
  const headers = new Headers({
    'Content-Type': file.content_type,
    'Content-Disposition': contentDisposition(file.file_name, inlineTypes.has(file.content_type)),
  });
  if (video) headers.set('Accept-Ranges', 'bytes');
  // HEAD は本文を取得しない。Range は GET にだけ適用する（RFC 9110）。
  if (request.head) {
    const object = await bucket.head(file.object_key);
    if (object === null) return null;
    headers.set('Content-Length', String(object.size));
    return new Response(null, { headers });
  }

  let range: ByteRange | undefined;
  // 検証子をまだ公開していないので If-Range があれば範囲を無視し、全体を返す。
  if (video && request.range !== undefined && request.ifRange === undefined) {
    const object = await bucket.head(file.object_key);
    if (object === null) return null;
    const parsed = byteRange(request.range, object.size);
    if (parsed === null) {
      // 成功のファイル名や Content-Type はエラーに載せず、API と同じ JSON の形にする。
      return new Response(JSON.stringify(errorBody('invalid_input', 'invalid input')), {
        status: 416,
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Content-Range': `bytes */${object.size}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }
    range = parsed;
  }
  const object = range === undefined ? await bucket.get(file.object_key) : await bucket.get(file.object_key, { range });
  if (object === null) return null;
  if (range !== undefined) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
  }
  headers.set('Content-Length', String(range?.length ?? object.size));
  return new Response(object.body, { status: range === undefined ? 200 : 206, headers });
}
