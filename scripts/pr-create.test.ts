import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { load } from 'js-yaml';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const prCreate = read('.claude/skills/pr-create/SKILL.md');
const stack = read('.claude/skills/pr-create/stack.md');

test('作成のひな形は、本文と draft=false を渡して通常の PR を1回で作る', (t) => {
  const section = prCreate.split('## Step 5-A: 作成モード')[1]?.split('## Step 5-B:')[0];
  const template = /```bash\n([\s\S]*?)```/.exec(section ?? '')?.[1];
  assert.ok(template, 'PR 作成コマンドが無い');
  const dir = mkdtempSync(join(tmpdir(), 'pr-create-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const body = 'Refs #789\n\n## 概要\n本文を作成前に用意する。\n';
  writeFileSync(join(dir, 'pr-body.md'), body);
  const capture = join(dir, 'request.json');
  const gh = join(dir, 'gh');
  // GitHub には接続せず、スキルのコマンドが実際に渡す引数と本文を記録する。
  writeFileSync(
    gh,
    `#!${process.execPath}\n` +
      `const fs = require('node:fs');\n` +
      `const args = process.argv.slice(2);\n` +
      `const bodyIndex = args.findIndex(arg => arg.startsWith('body='));\n` +
      `const value = bodyIndex < 0 ? null : args[bodyIndex].slice(5);\n` +
      `const body = args[bodyIndex - 1] === '-F' && value?.startsWith('@') ? fs.readFileSync(value.slice(1), 'utf8') : value;\n` +
      `fs.appendFileSync(process.env.PR_REQUEST, JSON.stringify({ args, body }) + '\\n');\n` +
      `process.stdout.write(JSON.stringify({ number: 123, url: 'https://example.test/pr/123' }));\n`,
  );
  chmodSync(gh, 0o755);
  const command = template
    .replaceAll('{owner}', 'example-org')
    .replaceAll('{repo}', 'app')
    .replaceAll('<base>', 'main')
    .replaceAll('<branch>', '789-open-pr')
    .replaceAll('<title>', 'PR を通常の状態で作る')
    .replaceAll('<スクラッチパッドの絶対パス>', dir);
  const result = spawnSync('bash', ['-eu', '-c', command], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PR_REQUEST: capture },
  });
  assert.equal(result.status, 0, result.stderr);
  const requests = readFileSync(capture, 'utf8').trim().split('\n');
  assert.equal(requests.length, 1, '作成は本文を用意した1回だけ');
  const request = JSON.parse(requests[0]!) as { args: string[]; body: string };
  assert.deepEqual(request.args.slice(0, 2), ['api', 'repos/example-org/app/pulls']);
  const fields = request.args.flatMap((arg, i) =>
    arg === '-f' || arg === '-F' ? [{ flag: arg, value: request.args[i + 1] }] : [],
  );
  assert.deepEqual(
    fields.filter((field) => field.value?.startsWith('draft=')),
    [{ flag: '-F', value: 'draft=false' }],
    'draft は文字列でなく boolean の false を明示する',
  );
  assert.ok(fields.some((field) => field.value === 'base=main'));
  assert.ok(fields.some((field) => field.value === 'head=789-open-pr'));
  assert.ok(fields.some((field) => field.value === 'title=PR を通常の状態で作る'));
  assert.equal(request.body, body);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'pr.json'), 'utf8')), {
    number: 123,
    url: 'https://example.test/pr/123',
  });
});

test('スタック PR も本文を用意してから各層を作成モードで作り、ドラフトの一括作成をしない', () => {
  assert.ok(stack.includes('Step 5-A（作成モード）'), '各層の PR を通常の作成モードで作る');
  assert.ok(stack.includes('本文を用意してから'), '作成時の AI レビューが読める本文を用意する');
  assert.ok(!stack.includes('gh stack submit'), 'ドラフトで先に一括作成する経路を残さない');
  assert.ok(!stack.includes('<!-- pr-create:draft-first -->'), '新しい PR に旧方式の目印を足さない');
});

test('AI レビューは opened が対象で、push と CI 完了を起動条件にしない', () => {
  const workflow = load(read('.github/workflows/ai-review.yml')) as {
    on: { pull_request: { types: string[] } };
    jobs: Record<string, { needs?: string | string[] }>;
  };
  assert.ok(workflow.on.pull_request.types.includes('opened'));
  assert.ok(!workflow.on.pull_request.types.includes('synchronize'));
  assert.equal(workflow.jobs.authorize?.needs, undefined);
  assert.equal(workflow.jobs.review?.needs, 'authorize');
});

// 旧方式の復旧手順は残しつつ、新規作成と対象の層を文書間で一致させる。
test('作成状態の再取得と、層ごとのベース指定を省かない', () => {
  assert.ok(prCreate.includes(`--jq '.state == "open" and .draft == false'`));
  assert.ok(stack.includes('比較のベース `origin/<その層の base>` を明示して渡す'));
  assert.ok(stack.includes('層ごとに回し直す'));
  const feedback = read('.claude/skills/pr-feedback/SKILL.md');
  assert.ok(feedback.includes('目印のあるドラフトのうち、文書だけの PR'));
  assert.ok(read('docs/development.md').includes('base が `main` の層では AI レビューも同時に走らせる'));
  assert.ok(read('.claude/skills/pr-create/github-mcp.md').includes('`draft: false` を明示'));
  for (const document of [prCreate, feedback, read('docs/development.md')]) {
    assert.ok(!document.includes('gh stack submit'), 'ドラフトを一括作成する経路を復活させない');
  }
});
