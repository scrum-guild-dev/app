import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { FullResult, TestCase, TestResult } from '@playwright/test/reporter';
import ExecutedReporter from './e2e-executed-reporter.ts';

const passed = { status: 'passed' } as FullResult;
const testCase = {} as TestCase;

for (const statuses of [[], ['skipped'], ['skipped', 'skipped']] as TestResult['status'][][]) {
  test(`実行0件を失敗にする（${statuses.join(',') || '対象なし'}）`, () => {
    const reporter = new ExecutedReporter();
    for (const status of statuses) reporter.onTestEnd(testCase, { status } as TestResult);
    assert.deepEqual(reporter.onEnd(passed), { status: 'failed' });
  });
}

for (const status of ['passed', 'failed', 'timedOut', 'interrupted'] as const) {
  test(`${status} は実行に数え、Playwright 自身の結果を上書きしない`, () => {
    const reporter = new ExecutedReporter();
    reporter.onTestEnd(testCase, { status: 'skipped' } as TestResult);
    reporter.onTestEnd(testCase, { status } as TestResult);
    assert.equal(reporter.onEnd(passed), undefined);
  });
}

for (const skip of [true, false]) {
  test(`Playwright 本体の終了コードで実行0件を拒否する（skip: ${skip}）`, (t) => {
    const cwd = mkdtempSync(join(tmpdir(), 'e2e-executed-reporter-'));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const root = fileURLToPath(new URL('../', import.meta.url));
    writeFileSync(
      join(cwd, 'playwright.config.ts'),
      `export default ${JSON.stringify({ testDir: cwd, outputDir: join(cwd, 'results'), reporter: [[join(root, 'scripts/e2e-executed-reporter.ts')]], workers: 1 })}`,
    );
    writeFileSync(
      join(cwd, 'sample.test.ts'),
      `import {test} from ${JSON.stringify(join(root, 'node_modules/@playwright/test/index.mjs'))}; test${skip ? '.skip' : ''}('sample', () => {});`,
    );
    const result = spawnSync('pnpm', ['exec', 'playwright', 'test', '--config', join(cwd, 'playwright.config.ts')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, skip ? 1 : 0, result.stdout + result.stderr);
    if (skip) assert.match(result.stderr, /実行されたテストが0件/);
  });
}
