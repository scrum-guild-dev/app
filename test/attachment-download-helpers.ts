// ダウンロードの公開 HTTP 口だけを呼ぶ。アップロード処理と独立に行と R2 を用意する。
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { app, pngFile } from './attachment-helpers.ts';
import { createAttachment } from './factories.ts';
import { testEnv, type Person, type Target } from './operations/world.ts';

export async function storedFile(
  target: Target,
  options: {
    person?: Person;
    workspaceId?: string;
    file?: Uint8Array;
    contentType?: string;
    fileName?: string;
    row?: Parameters<typeof createAttachment>[3];
  } = {},
) {
  const bytes = options.file ?? pngFile();
  const row = await createAttachment(
    target.organization,
    options.workspaceId ?? target.workspace.id,
    (options.person ?? target.member).userId!,
    {
      content_type: options.contentType ?? 'image/png',
      file_name: options.fileName ?? '画面.png',
      size_bytes: bytes.byteLength,
      ...options.row,
    },
  );
  // R2 側のメタデータを採用すると危険。配信の型は DB の保存値で決める。
  await env.ATTACHMENTS.put(row.object_key, bytes, { httpMetadata: { contentType: 'text/html' } });
  return { row, bytes };
}

export async function download(
  target: Target,
  id: string,
  options: { person?: Person | null; bearer?: string; headers?: Record<string, string>; env?: Env; slug?: string } = {},
): Promise<Response> {
  const person = options.person === undefined ? target.member : options.person;
  const bindings = options.env ?? testEnv;
  const headers = new Headers(options.headers);
  if (person !== null) headers.set('Cookie', `${sessionCookieName(bindings.PUBLIC_ORIGIN)}=${person.token}`);
  if (options.bearer !== undefined) headers.set('Authorization', `Bearer ${options.bearer}`);
  // img、video、通常のリンクの GET には Origin が無い。
  return app.request(`/api/${options.slug ?? target.slug}/attachments/${id}`, { method: 'GET', headers }, bindings);
}

export function expectDownloadHeaders(response: Response): void {
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(
    response.headers
      .get('Cache-Control')
      ?.split(',')
      .map((part) => part.trim()),
  ).toContain('private');
  const directives = response.headers
    .get('Content-Security-Policy')
    ?.split(';')
    .map((part) => part.trim());
  expect(directives).toContain('sandbox');
  expect(directives).toContain("default-src 'none'");
}

// 引用符内のセミコロンやエスケープを壊さず、意図しないパラメータが増えていないことも見る。
export function expectSafeDisposition(
  response: Response,
  fileName: string,
  disposition: 'inline' | 'attachment',
): void {
  const value = response.headers.get('Content-Disposition');
  expect(value).not.toBeNull();
  expect(value).toMatch(/^[\x20-\x7e]+$/);
  expect(value!.split(';')[0]).toBe(disposition);
  const parameters = value!.slice(disposition.length);
  const pattern = /;\s*(filename\*?)=("(?:[^"\\]|\\.)*"|[^;\s]+)/gy;
  const parsed: Record<string, string> = {};
  let consumed = 0;
  for (let match = pattern.exec(parameters); match !== null; match = pattern.exec(parameters)) {
    expect(parsed[match[1]!], '同名のパラメータを重複しない').toBeUndefined();
    parsed[match[1]!] = match[2]!;
    consumed = pattern.lastIndex;
  }
  expect(consumed, '引用符や区切りを壊していない').toBe(parameters.length);
  expect(Object.keys(parsed).sort()).toEqual(['filename', 'filename*']);
  expect(parsed.filename).toMatch(/^("(?:[^"\\]|\\.)*"|[!#$%&'*+.^_`|~0-9A-Za-z-]+)$/);
  expect(parsed['filename*']).toMatch(/^UTF-8''[!#$&+.^_`|~0-9A-Za-z%-]+$/i);
  expect(decodeURIComponent(parsed['filename*']!.slice(7))).toBe(fileName);
}
