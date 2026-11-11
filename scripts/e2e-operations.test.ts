import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { APIResponse, Page, Route } from '@playwright/test';
import { z } from 'zod';
import { routeOperation } from '../e2e/operations.ts';
import { defineOperation } from '../src/shared/operations/define.ts';

const definition = defineOperation({
  name: 'test-read',
  description: '応答の読み取りの検査',
  permission: 'login',
  mode: 'read',
  input: z.object({}),
  output: z.object({ valid: z.boolean() }),
});

async function readResponse(response: Pick<APIResponse, 'text' | 'json' | 'ok' | 'status'>) {
  let handler: ((route: Route) => Promise<void>) | undefined;
  let output: unknown;
  let fulfilled = false;
  const page = {
    route: async (_url: string, callback: (route: Route) => Promise<void>) => {
      handler = callback;
    },
  } as unknown as Page;
  await routeOperation(page, definition, async (call) => {
    output = await call.fetch();
    await call.fulfill(output as { valid: boolean });
  });
  assert.ok(handler);
  await handler({
    request: () => ({ postDataJSON: () => ({}) }),
    fetch: async () => response,
    fulfill: async () => {
      fulfilled = true;
    },
  } as unknown as Route);
  assert.equal(fulfilled, true);
  return output;
}

test('正常な JSON の応答を読み取って返す', async () => {
  const response = new Response('{"valid":true}');
  assert.deepEqual(
    await readResponse({
      text: () => response.text(),
      json: () => response.json(),
      ok: () => true,
      status: () => 200,
    }),
    { valid: true },
  );
});

test('本文が JSON でない 200 の応答は、操作名を含む失敗にする', async () => {
  const response = new Response('<html></html>');
  await assert.rejects(
    readResponse({
      text: () => response.text(),
      json: () => response.json(),
      ok: () => true,
      status: () => 200,
    }),
    /操作 test-read の本物の応答が JSON でない（200）/,
  );
});

test('テスト終了で応答が破棄されたときは、JSON の失敗にせず元の例外を投げる', async () => {
  const error = new Error('Response has been disposed');
  await assert.rejects(
    readResponse({
      text: async () => {
        throw error;
      },
      json: async () => {
        throw error;
      },
      ok: () => true,
      status: () => 200,
    }),
    (actual) => actual === error,
  );
});
