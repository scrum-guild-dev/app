// #739: R2 を消す道具を受け取る定義は、組織の中の書き込みに限る。
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { assertOperationDefinition, type AnyOperationDefinition } from '../src/shared/operations/define.ts';
import { createApp } from '../src/server/app.ts';
import type { ImplementedOperation } from '../src/server/operations/implement.ts';

const forged = (overrides: Record<string, unknown>) =>
  ({
    name: 'lantern-delete',
    description: '灯りの絵を消す仮の操作',
    permission: 'member',
    workspace: true,
    mode: 'write',
    storage: 'attachments',
    input: z.object({ workspace_id: z.string() }),
    output: z.object({}),
    ...overrides,
  }) as unknown as AnyOperationDefinition;

describe('添付を消す道具の宣言', () => {
  test('組織の中の write にだけ attachments を渡せる', () => {
    expect(() => assertOperationDefinition(forged({}))).not.toThrow();
    expect(() => assertOperationDefinition(forged({ permission: 'organization', workspace: undefined }))).not.toThrow();
  });
  test.each(['login', 'operator'])('組織の外の %s には渡さない', (permission) => {
    expect(() => assertOperationDefinition(forged({ permission, workspace: undefined }))).toThrow(/storage/);
  });
  test('read の操作には渡さない', () => {
    expect(() => assertOperationDefinition(forged({ mode: 'read' }))).toThrow(/storage/);
  });
  test.each(['other', '', true, null])('未知の storage %j を断る', (storage) => {
    expect(() => assertOperationDefinition(forged({ storage }))).toThrow(/storage/);
  });
  test('登録の入口も不正な storage を断る', () => {
    const broken = { definition: forged({ mode: 'read' }), handler: async () => ({}) } as ImplementedOperation;
    expect(() => createApp([broken])).toThrow(/storage/);
  });
});
