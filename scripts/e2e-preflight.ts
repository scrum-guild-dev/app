// クラウドの PR 前検査。CI と同じ判定・実行条件で検査し、対象コードと結果を残す。
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_RESULT_PREFIX } from './e2e-run.ts';
import { isDocsOnly, needsDevBuild, parseNulSeparated, repeatFiles } from './ci.ts';

type Mode = 'normal' | 'dev' | 'repeat';
type Run = (mode: Mode, files: string[], version: string, log: string) => 'passed' | 'skipped';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
  return result.stdout;
}

export function inputFingerprint(cwd: string): string {
  const paths = [
    ...new Set(parseNulSeparated(git(cwd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'))),
  ].sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    // 秘密の値を検査記録のために読むことも避ける。
    if (/(^|\/)(\.env|\.dev\.vars)(\.|$)/.test(path)) continue;
    hash.update(`${path}\0`);
    const file = join(cwd, path);
    if (!existsSync(file)) {
      hash.update('deleted\0');
      continue;
    }
    const stat = lstatSync(file);
    hash.update(`${stat.mode}\0`);
    hash.update(stat.isSymbolicLink() ? readlinkSync(file) : readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function preflightPlan(changed: string[], addedOrModified: string[]): { mode: Mode; files: string[] }[] {
  if (isDocsOnly(changed)) return [];
  const plan: { mode: Mode; files: string[] }[] = [{ mode: 'normal', files: [] }];
  if (needsDevBuild(changed)) plan.push({ mode: 'dev', files: [] });
  const files = repeatFiles(addedOrModified);
  if (files.length) plan.push({ mode: 'repeat', files });
  return plan;
}

export function runPreflight(base = 'origin/main', options: { cwd?: string; run?: Run } = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const baseSha = git(cwd, 'rev-parse', '--verify', `${base}^{commit}`).trim();
  const head = git(cwd, 'rev-parse', 'HEAD').trim();
  const mergeBase = git(cwd, 'merge-base', baseSha, head).trim();
  // 作業中の修正と新規テストも対象に含める。リネームは削除と追加として扱う。
  const untracked = parseNulSeparated(git(cwd, 'ls-files', '-z', '--others', '--exclude-standard'));
  const changed = [
    ...parseNulSeparated(git(cwd, 'diff', '--name-only', '--no-renames', '-z', mergeBase)),
    ...untracked,
  ];
  const added = [
    ...parseNulSeparated(git(cwd, 'diff', '--name-only', '--no-renames', '--diff-filter=AM', '-z', mergeBase)),
    ...untracked,
  ];
  const plan = preflightPlan(changed, added);
  const fingerprint = inputFingerprint(cwd);
  const dir = join(cwd, '.e2e-preflight', `${Date.now()}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const report = {
    head,
    base: baseSha,
    mergeBase,
    fingerprint,
    node: process.version,
    pnpm: spawnSync('pnpm', ['--version'], { cwd, encoding: 'utf8' }).stdout?.trim(),
    started: new Date().toISOString(),
    finished: '',
    success: false,
    checks: plan.map((step) => ({ ...step, status: 'pending', log: join(dir, `${step.mode}.log`) })),
  };
  const save = () => writeFileSync(join(dir, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  const run: Run =
    options.run ??
    ((mode, files, version, log) => {
      const fd = openSync(log, 'w');
      try {
        const result = spawnSync(process.execPath, ['scripts/e2e-run.ts', mode, ...files], {
          cwd,
          env: { ...process.env, APP_VERSION: version, E2E_SERVER_VERSION: version },
          stdio: ['ignore', fd, fd],
        });
        if (result.error) throw result.error;
        if (result.status !== 0)
          throw new Error(`${mode} が失敗 (${result.status ?? result.signal})。${log} を確認する`);
        const line = readFileSync(log, 'utf8').trimEnd().split('\n').at(-1);
        if (!line?.startsWith(E2E_RESULT_PREFIX)) throw new Error(`検査の結果が無い: ${log}`);
        const { status } = JSON.parse(line.slice(E2E_RESULT_PREFIX.length)) as { status: string };
        if (status !== 'passed' && status !== 'skipped') throw new Error(`不明な検査結果: ${log}`);
        return status;
      } finally {
        closeSync(fd);
      }
    });
  save();
  try {
    for (const step of report.checks) {
      console.log(`[e2e:preflight] ${step.mode}: ${step.log}`);
      step.status = 'running';
      save();
      try {
        for (const artifact of ['test-results', 'playwright-report']) {
          rmSync(join(cwd, artifact), { recursive: true, force: true });
        }
        step.status = run(step.mode, step.files, `preflight-${randomUUID()}`, step.log);
      } catch (error) {
        step.status = 'failed';
        throw error;
      } finally {
        for (const artifact of ['test-results', 'playwright-report']) {
          const source = join(cwd, artifact);
          if (step.status !== 'skipped' && existsSync(source))
            cpSync(source, join(dir, step.mode, artifact), { recursive: true });
        }
        save();
      }
    }
    if (inputFingerprint(cwd) !== fingerprint || git(cwd, 'rev-parse', 'HEAD').trim() !== head) {
      throw new Error('検査中にコードが変わったため結果を再利用できない。e2e:preflight をやり直す');
    }
    report.success = true;
    return join(dir, 'result.json');
  } finally {
    report.finished = new Date().toISOString();
    save();
    console.log(`[e2e:preflight] 結果: ${join(dir, 'result.json')}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('使い方: pnpm e2e:preflight [base-ref]');
  runPreflight(process.argv[2]);
}
