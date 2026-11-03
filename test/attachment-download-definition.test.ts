// GET の追加が書き込みや別の権限を Origin 無しで開かないことを、登録時にも確かめる。
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { attachmentDownload, attachmentUpload } from '../src/shared/operations/attachment/index.ts';
import {
  assertOperationDefinition,
  defineOperation,
  operationMethod,
  operationPath,
  type AnyOperationDefinition,
} from '../src/shared/operations/define.ts';
import { operations } from '../src/shared/operations/index.ts';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { tokenAllows } from '../src/server/operations/token-scope.ts';

describe('ファイルを返す操作の定義', () => {
  test('本番の一覧に GET の読み取りとして登録され、API トークンでは呼べない', () => {
    expect(attachmentDownload).toMatchObject({
      name: 'attachments',
      permission: 'organization',
      mode: 'read',
      response: 'binary',
    });
    expect(operations).toContain(attachmentDownload);
    expect(implementedOperations.map((operation) => operation.definition)).toContain(attachmentDownload);
    expect(tokenAllows(attachmentDownload, 'read')).toBe(false);
    expect(tokenAllows(attachmentDownload, 'write')).toBe(false);
  });

  test.each([
    { response: 'json' },
    { response: null },
    { response: true },
    { mode: 'write' },
    { permission: 'login' },
    { permission: 'operator' },
    { permission: 'invitee' },
    { permission: 'admin' },
    { permission: 'member', workspace: true, input: z.object({ workspace_id: z.string() }) },
    { workspace: true, input: z.object({ workspace_id: z.string() }) },
    { body: 'binary' },
  ])('型を消した不正な定義 %j を定義と登録の両方で断る', (overrides) => {
    const definition = { ...attachmentDownload, ...overrides } as unknown as AnyOperationDefinition;
    expect(() => assertOperationDefinition(definition)).toThrow();
    expect(() => defineOperation(definition)).toThrow();
    expect(() => createApp([{ definition, handler: async () => new Response() }])).toThrow();
  });

  test('GET の URL を定義から作り、slug と id を1区分としてエンコードする', () => {
    expect(operationMethod(attachmentDownload)).toBe('GET');
    expect(operationPath(attachmentDownload, 'aoba')).toBe('/api/aoba/attachments/:id');
    expect(operationPath(attachmentDownload, 'aoba', { id: '123/456?x#y' })).toBe(
      '/api/aoba/attachments/123%2F456%3Fx%23y',
    );
    expect(operationPath(attachmentDownload, 'aoba/x', { id: '123' })).toBe('/api/aoba%2Fx/attachments/123');
    expect(() => operationPath(attachmentDownload)).toThrow();
    expect(operationMethod(attachmentUpload)).toBe('POST');
    expect(operationPath(attachmentUpload, 'aoba')).toBe('/api/aoba/attachment-upload');
  });

  test('応答のスキーマは JSON を通さず、Response を受け取る', () => {
    const response = new Response('file');
    expect(attachmentDownload.output.parse(response)).toBe(response);
    expect(attachmentDownload.output.safeParse({ body: 'file', status: 200 }).success).toBe(false);
  });
});
