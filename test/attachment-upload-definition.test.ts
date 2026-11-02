// 本文の種類 body: 'binary' の定義の決まり（Issue #744）。付けられるのは組織の中の write の操作だけで、
// 呼べる操作の一覧（operation-list）と、そこから作る MCP の道具に出さない。API トークン（write）では直に呼べる
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { listTools } from '../cli/lib/mcp-tools.ts';
import type { CliDeps } from '../cli/lib/main.ts';
import {
  assertOperationDefinition,
  defineOperation,
  type AnyOperationDefinition,
} from '../src/shared/operations/define.ts';
import { attachmentUpload } from '../src/shared/operations/attachment/index.ts';
import { operations } from '../src/shared/operations/index.ts';
import { operationList } from '../src/shared/operations/session/index.ts';
import { createApp } from '../src/server/app.ts';
import { implement, type ImplementedOperation } from '../src/server/operations/implement.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { operationListOperationFor } from '../src/server/operations/operation-list.ts';
import { tokenAllows } from '../src/server/operations/token-scope.ts';
import { insertApiToken, type TokenScope } from './operations/api-token.ts';
import { post } from './operations/harness.ts';
import { createLoginPerson, createTarget, testEnv, type Person } from './operations/world.ts';

const workspaceWrite = {
  name: 'lantern-upload',
  description: '灯りの絵を上げる仮の操作',
  mode: 'write',
  permission: 'member',
  workspace: true,
  input: z.object({ workspace_id: z.string() }),
  output: z.object({}),
} as const;

// 型の検査を抜けた定義（型を消した一覧、手で組んだオブジェクト）
const forged = (overrides: Record<string, unknown>) =>
  ({ ...workspaceWrite, ...overrides }) as unknown as AnyOperationDefinition;

describe('assertOperationDefinition と body', () => {
  test('ワークスペースの下の write と、組織の中の write には binary を付けられる', () => {
    expect(() => assertOperationDefinition(forged({ body: 'binary' }))).not.toThrow();
    expect(() =>
      assertOperationDefinition(
        forged({ body: 'binary', permission: 'admin', workspace: undefined, input: z.object({}) }),
      ),
    ).not.toThrow();
    expect(() =>
      assertOperationDefinition(forged({ body: 'binary', permission: 'organization', workspace: undefined })),
    ).not.toThrow();
    expect(() => assertOperationDefinition(attachmentUpload)).not.toThrow();
  });

  test('body を付けない定義は今までどおり通る', () => {
    expect(() => assertOperationDefinition(forged({}))).not.toThrow();
  });

  test.each([['json'], ['text'], ['BINARY'], [''], [true], [1], [null]])('body が %j は断る', (body) => {
    expect(() => assertOperationDefinition(forged({ body }))).toThrow(/body/);
  });

  test.each([['login'], ['operator']])('組織の外の操作（%s）の binary は断る', (permission) => {
    expect(() =>
      assertOperationDefinition(forged({ body: 'binary', permission, workspace: undefined, input: z.object({}) })),
    ).toThrow(/body/);
  });

  test('read の操作の binary は断る（ワークスペースの下でも組織の中でも）', () => {
    expect(() => assertOperationDefinition(forged({ body: 'binary', mode: 'read' }))).toThrow(/body/);
    expect(() =>
      assertOperationDefinition(
        forged({ body: 'binary', mode: 'read', permission: 'organization', workspace: undefined }),
      ),
    ).toThrow(/body/);
  });

  test('defineOperation も、登録（createApp）も、誤った body を断る', () => {
    expect(() => defineOperation(forged({ body: 'binary', mode: 'read' }))).toThrow(/body/);
    const broken = {
      definition: forged({ body: 'json' }),
      handler: async () => ({}),
    } as unknown as ImplementedOperation;
    expect(() => createApp([broken])).toThrow(/body/);
  });
});

describe('attachment-upload の定義と登録', () => {
  test('権限 member、ワークスペースの下、write、body: binary', () => {
    expect(attachmentUpload).toMatchObject({
      name: 'attachment-upload',
      permission: 'member',
      workspace: true,
      mode: 'write',
      body: 'binary',
    });
  });

  test('本番の定義の一覧と、登録する操作の一覧に入っている', () => {
    expect(operations).toContain(attachmentUpload);
    expect(implementedOperations.map((operation) => operation.definition)).toContain(attachmentUpload);
  });

  test('API トークンでは書き込みでも読み取りでも呼べない（一覧に出ないことと同じ判定）', () => {
    expect(tokenAllows(attachmentUpload, 'write')).toBe(false);
    expect(tokenAllows(attachmentUpload, 'read')).toBe(false);
  });

  test('入力のファイル名は前後の空白を除き、255 字までで、制御文字を断る', () => {
    const workspace_id = crypto.randomUUID();
    expect(attachmentUpload.input.parse({ workspace_id, file_name: '  a.png ' })).toEqual({
      workspace_id,
      file_name: 'a.png',
    });
    expect(attachmentUpload.input.safeParse({ workspace_id, file_name: '📎'.repeat(255) }).success).toBe(true);
    for (const file_name of ['', ' ', '📎'.repeat(256), 'a\u0000b', 'a\u001fb', 'a​b']) {
      expect(attachmentUpload.input.safeParse({ workspace_id, file_name }).success, JSON.stringify(file_name)).toBe(
        false,
      );
    }
  });
});

type Listed = { name: string };

async function listedNames(app: ReturnType<typeof createApp>, person: Person, credential: 'cookie' | TokenScope) {
  const auth =
    credential === 'cookie'
      ? { token: person.token }
      : { bearer: (await insertApiToken(person.accountId, { scope: credential })).raw, origin: null };
  const res = await post(app, operationList, auth);
  expect(res.status).toBe(200);
  return ((await res.json()) as { operations: Listed[] }).operations.map((operation) => operation.name);
}

describe('operation-list に body: binary の操作を出さない', () => {
  for (const credential of ['cookie', 'write', 'read'] as const) {
    test(`本番の一覧（${credential}）に attachment-upload が無い`, async () => {
      const person = await createLoginPerson();
      const names = await listedNames(createApp(), person, credential);
      expect(names).not.toContain('attachment-upload');
      expect(names).toContain('operation-list');
    });
  }

  test('仮の binary の操作は、同じ形の JSON の操作が載る一覧でも載らない', async () => {
    const binary = defineOperation({ ...workspaceWrite, name: 'lantern-upload', body: 'binary' });
    const json = defineOperation({ ...workspaceWrite, name: 'lantern-rename' });
    const implemented = [implement(binary, async () => ({})), implement(json, async () => ({}))];
    const app = createApp([
      ...implemented,
      operationListOperationFor(implemented.map((operation) => operation.definition)),
    ]);
    const person = await createLoginPerson();
    const names = await listedNames(app, person, 'write');
    expect(names).toContain('lantern-rename');
    expect(names).not.toContain('lantern-upload');
  });

  test('MCP の道具（書き込みを許した一覧）にも attachment-upload が出ない', async () => {
    const app = createApp();
    const target = await createTarget();
    const { raw } = await insertApiToken(target.member.accountId, { scope: 'write' });
    const deps: CliDeps = {
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        app.fetch(new Request(input, init), testEnv)) as typeof fetch,
      env: {},
      stdout: () => {},
      stderr: () => {},
      readStdin: async () => '',
      config: { read: async () => undefined, write: async () => {} },
    };
    const tools = await listTools(
      deps,
      { url: 'https://mcp.guild.example', token: raw, org: target.slug, workspace: target.workspace.id },
      { allowWrite: true },
    );
    const names = tools.map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('comment-create');
    expect(names).not.toContain('attachment-upload');
  });
});
