// pnpm dev: vite dev（画面、HMR）と wrangler dev（API）を並べて立てる。vite が /api を wrangler dev へ転送する。
// pnpm preview（--preview）: build 済みの build/ と API を、本番と同じ配り方で wrangler dev だけで配る。
// --test-credentials は e2e 専用の架空鍵を渡す。通常の開発では使わない（計測スクリプトも同じ架空鍵を明示する）。
// どちらかが止まったら残りも止める。ポートがぶつかったときに片方だけ動き続けないようにするため。
import { spawn, type ChildProcess } from 'node:child_process';
import { TEST_CREDENTIAL_KEYS } from './test-credential-keys.ts';
import { devPorts, devPublicOrigin } from './dev-ports.ts';
import { checkDevVars } from './dev-vars.ts';

const preview = process.argv.includes('--preview');
const ports = devPorts(process.env);
const version = process.env.APP_VERSION;

// .dev.vars を通さずに wrangler へ渡す値。.dev.vars の鍵の確かめも、ここに無い鍵だけを見る
const vars: [string, string][] = [
  ...(process.argv.includes('--test-credentials')
    ? [['CONNECTION_CREDENTIAL_KEYS', TEST_CREDENTIAL_KEYS] as [string, string]]
    : []),
  ...(version ? [['APP_VERSION', version] as [string, string]] : []),
  ['PUBLIC_ORIGIN', devPublicOrigin(ports, preview)],
];

const wranglerArgs = [
  'dev',
  '--port',
  String(ports.api),
  '--inspector-port',
  String(ports.inspector),
  ...vars.flatMap(([name, value]) => ['--var', `${name}:${value}`]),
];

// wrangler は起動したディレクトリの .dev.vars を読むので、同じ場所で鍵の名前を比べる。足りなくても起動は止めない
const devVarsWarning = checkDevVars(
  process.cwd(),
  vars.map(([name]) => name),
);
if (devVarsWarning) console.error(devVarsWarning);

const commands: [string, string[]][] = preview
  ? [['wrangler', wranglerArgs]]
  : [
      ['wrangler', wranglerArgs],
      ['vite', ['dev']],
    ];

const children: ChildProcess[] = [];
let stopping = false;

function stopAll(code: number) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

for (const [command, args] of commands) {
  const child = spawn(command, args, { stdio: 'inherit' });
  child.on('error', (err) => {
    console.error(`${command} を起動できませんでした: ${err.message}`);
    stopAll(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) console.error(`${command} が止まりました（${signal ?? code}）。残りも止めます`);
    stopAll(code ?? 1);
  });
  children.push(child);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => stopAll(0));
}

console.log(
  preview
    ? `preview: http://localhost:${ports.api}`
    : `dev: http://localhost:${ports.app}（API は http://localhost:${ports.api}）`,
);
