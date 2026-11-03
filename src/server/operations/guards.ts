// 登録の関数が操作の前に行う検査のうち、DB を引かないもの
import type { Context } from 'hono';
import type { z } from 'zod';
import { ATTACHMENT_MAX_BYTES } from '../../shared/operations/attachment/index.ts';
import { ApiError } from '../errors.ts';
import type { AppEnv } from '../app-env.ts';
import type { BinaryBody } from './implement.ts';

const MAX_BODY_BYTES = 1024 * 1024;

// Origin が公開する URL と違う呼び出しを断る。すべての操作に掛ける。Origin の無い呼び出しも断る
// （ブラウザは POST に必ず Origin を付けるので、付いていないのは画面からの呼び出しではない）
export function requireOrigin(c: Context<AppEnv>): void {
  // 設定の誤りは握りつぶさず、new URL() の例外から 500 にする
  const allowed = new URL(c.env.PUBLIC_ORIGIN).origin;
  if (c.req.header('Origin') !== allowed) throw new ApiError(403, 'forbidden');
}

// img/video/リンクの GET は Origin が無い。同一オリジンの読み込みと直接の移動だけを通す。
// 古いブラウザや手元の HTTP クライアントのため、Fetch Metadata の無い呼び出しも認証へ進める。
export function requireDownloadOrigin(c: Context<AppEnv>): void {
  if (c.req.header('Origin') !== undefined) requireOrigin(c);
  const site = c.req.header('Sec-Fetch-Site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new ApiError(403, 'forbidden');
}

export function readDownloadInput<Schema extends z.ZodType>(c: Context<AppEnv>, schema: Schema): z.output<Schema> {
  const parsed = schema.safeParse({ id: c.req.param('id') });
  if (!parsed.success) throw new ApiError(400, 'invalid_input');
  return parsed.data;
}

// 本文を上限（バイト）まで読む。Content-Length が無い（chunked の）本文も、読んだ分を数えて上限で止める。
// 超えたら 413 の invalid_input。操作の定義のほか、画面のエラーの送信（src/server/client-errors.ts）が小さい上限で使う
export async function readBodyText(c: Context<AppEnv>, maxBytes: number = MAX_BODY_BYTES): Promise<string> {
  const declared = c.req.header('Content-Length');
  if (declared !== undefined && Number(declared) > maxBytes) throw new ApiError(413, 'invalid_input');
  const body = c.req.raw.body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new ApiError(413, 'invalid_input');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ApiError(400, 'invalid_input');
  }
}

// 入力は JSON の本文、binary の操作だけ X-Operation-Input。URL のクエリは読まない。
// Origin とセッションの検査の後に呼ぶ（未ログインの呼び出しに本文を読ませない）
export async function readInput<Schema extends z.ZodType>(
  c: Context<AppEnv>,
  schema: Schema,
  bodyType?: 'binary',
  maxBodyBytes?: number,
): Promise<z.output<Schema>> {
  let body: unknown;
  try {
    if (bodyType === 'binary') {
      const header = c.req.header('X-Operation-Input');
      if (header === undefined) throw new ApiError(400, 'invalid_input');
      body = JSON.parse(decodeURIComponent(header));
    } else {
      const contentType = c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') throw new ApiError(400, 'invalid_input');
      const text = await readBodyText(c, maxBodyBytes);
      if (maxBodyBytes !== undefined && maxBodyBytes > MAX_BODY_BYTES) checkLargeJsonStructure(text);
      body = JSON.parse(text);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, 'invalid_input');
  }
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  // 項目ごとの結果。message は zod の文で、入力の値は含めないが、入力のキーの名前は含みうる（未知のキーの指摘など）
  throw new ApiError(
    400,
    'invalid_input',
    parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      code: issue.code,
      message: issue.message,
    })),
  );
}

// JSON.parseの前に構造の量を制限し、大量の空オブジェクト等を実体化させない。
// 大きな入力であっても、正規の入力は少数の長文ファイル。文字列内の記号は数えない。
function checkLargeJsonStructure(text: string) {
  let quoted = false;
  let escaped = false;
  let structures = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if ('{}[],:'.includes(char) && ++structures > 512) {
      throw new ApiError(400, 'invalid_input');
    }
  }
}

// ヘッダーの入力を検証した後、ワークスペースを確かめる前に呼ぶ。本文はここでは読まない。
export function readBinaryBody(c: Context<AppEnv>): BinaryBody {
  const declared = c.req.header('Content-Length');
  if (declared === undefined || !/^[0-9]+$/.test(declared)) throw new ApiError(400, 'invalid_input');
  const contentLength = Number(declared);
  if (contentLength === 0) throw new ApiError(400, 'invalid_input');
  if (contentLength > ATTACHMENT_MAX_BYTES) throw new ApiError(413, 'invalid_input');
  const body = c.req.raw.body;
  if (body === null) throw new ApiError(400, 'invalid_input');
  return { body, contentLength, bucket: c.env.ATTACHMENTS };
}
