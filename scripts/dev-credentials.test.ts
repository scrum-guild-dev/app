import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TEST_CREDENTIAL_KEYS } from './test-credential-keys.ts';

test('開発サーバーは専用フラグで架空の鍵だけを渡し、環境変数の実鍵を引数へ出さない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-credentials-'));
  try {
    const wrangler = join(dir, 'wrangler');
    writeFileSync(wrangler, `#!${process.execPath}\nconsole.log('ARGS:' + JSON.stringify(process.argv.slice(2)));\n`);
    chmodSync(wrangler, 0o755);
    for (const testCredentials of [false, true]) {
      const child = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./dev.ts', import.meta.url)),
          '--preview',
          ...(testCredentials ? ['--test-credentials'] : []),
        ],
        {
          // dev.ts は作業ディレクトリの .dev.vars を読むので、手元の本物の .dev.vars が無い一時ディレクトリで動かす
          cwd: dir,
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            CONNECTION_CREDENTIAL_KEYS: 'private-key-sentinel',
          },
        },
      );
      assert.equal(child.status, 0, child.stderr);
      assert.ok(!child.stdout.includes('private-key-sentinel'));
      const line = child.stdout.split('\n').find((line) => line.startsWith('ARGS:'));
      assert.ok(line, child.stdout);
      const args = JSON.parse(line.slice(5)) as string[];
      const bindings = args.filter((arg) => arg.startsWith('CONNECTION_CREDENTIAL_KEYS:'));
      assert.deepEqual(bindings, testCredentials ? [`CONNECTION_CREDENTIAL_KEYS:${TEST_CREDENTIAL_KEYS}`] : []);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
