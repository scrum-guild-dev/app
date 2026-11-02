// 添付ファイルを上げる操作（attachment-upload）のテストが使う道具。行と R2 の中身を読み、挿入を失敗させ、R2 の呼び出しを記録する
/* eslint-disable db-entry/guard -- 挿入の失敗を起こすトリガーを、入口を通さず D1 に直に当てるため */
import { env } from 'cloudflare:workers';
import { attachmentUpload } from '../src/shared/operations/attachment/index.ts';
import { createApp } from '../src/server/app.ts';
import { orgDb } from '../src/server/db/index.ts';
import { post } from './operations/harness.ts';
import { testEnv, type Person, type Target } from './operations/world.ts';

export const MAX_BYTES = 52_428_800;

export const app = createApp();

export const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngFile(extra = 8): Uint8Array {
  const file = new Uint8Array(PNG_HEAD.byteLength + extra);
  file.set(PNG_HEAD);
  for (let i = PNG_HEAD.byteLength; i < file.byteLength; i++) file[i] = i & 0xff;
  return file;
}

export const textBytes = (value: string) => new TextEncoder().encode(value);

export type UploadOptions = {
  person?: Person;
  workspaceId?: string;
  fileName?: string;
  // 入力をそのまま渡す（workspaceId と fileName より優先）
  input?: unknown;
  file?: string | Uint8Array | ReadableStream<Uint8Array>;
  contentLength?: string | null;
  headers?: Record<string, string>;
  env?: Env;
};

// 対象の組織の slug で、入力をヘッダーで、ファイルを本文で送る。人の省略はワークスペースの一般のメンバー
export function upload(target: Target, options: UploadOptions = {}): Promise<Response> {
  const person = options.person ?? target.member;
  return post(app, attachmentUpload, {
    slug: target.slug,
    token: person.token,
    body: options.input ?? {
      workspace_id: options.workspaceId ?? target.workspace.id,
      file_name: options.fileName ?? '画面の案.png',
    },
    file: options.file ?? pngFile(),
    ...(options.contentLength === undefined ? {} : { contentLength: options.contentLength }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

export type UploadOutput = {
  id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
};

// 組織の attachments の行。ワークスペースを渡せば、その行だけ
export async function attachmentRows(target: Target, workspaceId?: string) {
  const db = orgDb(env, target.organization.verified);
  const workspaceIds = workspaceId === undefined ? [target.workspace.id, target.otherWorkspace.id] : [workspaceId];
  return db.rows(
    db.statement((q) => q.selectFrom('attachments').selectAll().where('workspace_id', 'in', workspaceIds)),
  );
}

// 組織の ID で始まる R2 のキー
export async function objectKeysOf(organizationId: string): Promise<string[]> {
  const listed = await env.ATTACHMENTS.list({ prefix: `${organizationId}/` });
  return listed.objects.map((object) => object.key);
}

export async function objectBytes(key: string): Promise<Uint8Array | undefined> {
  const object = await env.ATTACHMENTS.get(key);
  if (object === null) return undefined;
  return new Uint8Array(await object.arrayBuffer());
}

// 何も書かなかったこと（行も R2 のファイルも無い）
export async function nothingWritten(target: Target): Promise<{ rows: number; objects: string[] }> {
  return { rows: (await attachmentRows(target)).length, objects: await objectKeysOf(target.organization.id) };
}

// そのワークスペースへの attachments の INSERT だけを、本物の D1 で失敗させるトリガー。ほかのファイルの行には当たらない。
// 返す関数で外す
export async function failInsertsInto(workspaceId: string): Promise<() => Promise<void>> {
  const name = `fail_attachment_${workspaceId.replace(/[^0-9a-f]/g, '')}`;
  await env.DB.exec(
    `CREATE TRIGGER ${name} BEFORE INSERT ON attachments WHEN NEW.workspace_id = '${workspaceId}' BEGIN SELECT RAISE(ABORT, 'insert failed'); END`,
  );
  return async () => {
    await env.DB.exec(`DROP TRIGGER IF EXISTS ${name}`);
  };
}

export type BucketCall = { method: string; key: unknown };

// 本物の R2 に流しながら、呼び出しの名前と最初の引数を記録する。overrides の関数は本物の代わりに呼ぶ
export function recordingBucket(overrides: Partial<Record<keyof R2Bucket, (...args: unknown[]) => unknown>> = {}): {
  bucket: R2Bucket;
  calls: BucketCall[];
  env: Env;
} {
  const base = env.ATTACHMENTS;
  const calls: BucketCall[] = [];
  const bucket = new Proxy(base, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push({ method: String(property), key: args[0] });
        const override = overrides[property as keyof R2Bucket];
        if (override !== undefined) return override(...args);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { bucket, calls, env: Object.assign({}, testEnv, { ATTACHMENTS: bucket }) };
}

// 指定の長さのバイトを、chunkSize ずつ作って流すストリーム。メモリに丸ごと持たない。
// highWaterMark 0 なので、読まれるまで作らない（pulls で読まれた回数が分かる）
export function generatedStream(
  size: number,
  options: { chunkSize?: number; head?: Uint8Array } = {},
): { stream: ReadableStream<Uint8Array>; pulls: () => number } {
  const chunkSize = options.chunkSize ?? 1024 * 1024;
  const head = options.head ?? PNG_HEAD;
  let sent = 0;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        if (sent >= size) {
          controller.close();
          return;
        }
        const length = Math.min(chunkSize, size - sent);
        const chunk = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
          const at = sent + i;
          chunk[i] = at < head.byteLength ? head[at]! : at & 0xff;
        }
        sent += length;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls: () => pulls };
}

// 渡したバイトを、1つずつ別の塊で流すストリーム
export function chunkedStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
}
