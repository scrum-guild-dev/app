import { expect, test } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { implementedOperations } from '../src/server/operations/index.ts';
import { operationList } from '../src/shared/operations/session/index.ts';
import { post } from './operations/harness.ts';
import { createTarget } from './operations/world.ts';

test('CLIとMCPが使う操作一覧に両Wikiの取り込みと入力形式を公開する', async () => {
  const target = await createTarget();
  const response = await post(createApp(implementedOperations), operationList, {
    token: target.member.token,
    body: {},
  });
  expect(response.status).toBe(200);
  const { operations } = (await response.json()) as {
    operations: { name: string; scope: string; input_schema: { properties: Record<string, unknown> } }[];
  };
  for (const [name, scope] of [
    ['org-wiki-upload', 'organization'],
    ['workspace-wiki-upload', 'workspace'],
  ]) {
    const operation = operations.find((item) => item.name === name);
    expect(operation?.scope).toBe(scope);
    expect(operation?.input_schema.properties.files).toMatchObject({ type: 'array', minItems: 1, maxItems: 20 });
  }
});
