import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('前面化に失敗しても、開いたブラウザを閉じずに人が閉じるまで待つ', () => {
  const entry = new URL('./dev-open.ts', import.meta.url).href;
  const mocks = {
    '@playwright/test': `
      let disconnected;
      export const chromium = { async launch() {
        return {
          on(event, callback) { if (event === 'disconnected') disconnected = callback; },
          async close() { console.log('BROWSER_CLOSED_BY_SCRIPT'); disconnected(); },
          async newContext() { return {
            async addInitScript() {}, async addCookies() {}, on() {},
            async newPage() { return {
              async goto() { console.log('PAGE_LOADED'); },
              async bringToFront() {
                // 人が後からブラウザを閉じるまで、読み込んだページを使える。
                setTimeout(() => { console.log('USER_CLOSED_BROWSER'); disconnected(); }, 30);
                throw new Error('focus unavailable');
              },
              isClosed() { return false; },
            }; },
          }; },
        };
      } };
    `,
    './dev-open-session.ts': 'export async function checkDevOpenSession() { return { ok: true }; }',
  };
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { registerHooks } from 'node:module';
       const entry = ${JSON.stringify(entry)};
       const mocks = ${JSON.stringify(mocks)};
       registerHooks({ resolve(specifier, context, nextResolve) {
         if (context.parentURL === entry && Object.hasOwn(mocks, specifier)) {
           return { url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]), shortCircuit: true };
         }
         return nextResolve(specifier, context);
       } });
       await import(entry);`,
    ],
    { encoding: 'utf8', timeout: 10_000, env: { ...process.env, DEV_PORT_OFFSET: '0' } },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PAGE_LOADED/);
  assert.match(result.stdout, /「手元の確かめ｜[^\n]+」のタブ/);
  assert.match(result.stdout, /USER_CLOSED_BROWSER/);
  assert.doesNotMatch(result.stdout, /BROWSER_CLOSED_BY_SCRIPT/);
  assert.match(result.stderr, /タブを前に出せない/);
});
