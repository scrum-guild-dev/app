// GitHub の MCP のツール（mcp__github__*）の判定。guard-bash.mjs が Bash で止める、main と production と v* のタグと
// Release の書き換えを、MCP の経路でも止める（docs/development.md の「`main` を守る仕組み」）。
// MCP のツールは Bash のフックに掛からないので、ここで見る。読むだけのツールは判定しない。

const DENY = 'deny';
const ASK = 'ask';

const MAIN_REASON = 'main には直接書かない。作業ブランチで作り PR を通す（CLAUDE.md の「守ること」）';
const PRODUCTION_REASON =
  'production は Release のワークフローだけが進める。セッションは書かず、production に向けた PR も作らない（docs/development.md の「ブランチ戦略」）';
const RELEASE_REASON =
  'Release とタグの作成、編集、publish、削除は人が行う。本番に出るのは人の publish だけ（docs/development.md の「リリース」）';
const MERGE_REASON =
  'MCP からはマージしない。手元の対話のセッションは作業ブランチの中で gh pr merge --squash --match-head-commit <head の40桁の SHA> を打ち、それ以外は人が行う（docs/development.md の「マージの判定」）';
const UNREADABLE_REASON =
  'ブランチの名前を字面で判定できない（文字列でない、空、エンコードや . と .. の区切りがある）。人が確かめる';
const GITHUB_DIR_REASON =
  '.github/ の下（ワークフローなど）を書く。作業ブランチのワークフローも push で動き、production やタグを動かしうる。人が確かめる';
const UNKNOWN_WRITE_REASON =
  '判定を知らない GitHub の MCP の書き込みのツール。main、production、v* のタグ、Release に触れるかを人が確かめる';

// 読むだけのツール。get_、list_、search_ で始まるもの（get_me なども含む）、_read で終わるもの（issue_read、
// pull_request_read、issue_dependency_read）、actions_get と actions_list。
// 名前だけで決めるので、get_ で始まる書き込みのツールが足されたら、ここを見直す
const READ_ONLY = /^(get|list|search)_|_read$|^actions_(get|list)$/;

// ブランチに書くツールと、ブランチの名前を受ける引数。main と production には書かせない
const BRANCH_WRITES = new Map([
  ['push_files', 'branch'],
  ['create_or_update_file', 'branch'],
  ['delete_file', 'branch'],
  ['create_branch', 'branch'],
]);

// PR の base を受けるツール。base が production の PR は、マージで production を進める。
// base が main の PR はふだんの作業なので止めない
const BASE_WRITES = new Map([
  ['create_pull_request', { key: 'base', required: true }],
  ['update_pull_request', { key: 'base', required: false }],
]);

// 守る ref に触れないと分かっている書き込み。Issue、PR のコメントとレビュー、ラベル、スレッドの解決など
const SAFE_WRITES = new Set([
  'add_issue_comment',
  'add_comment_to_pending_review',
  'add_reply_to_pull_request_comment',
  'issue_write',
  'sub_issue_write',
  'pull_request_review_write',
  'resolve_review_thread',
  'unresolve_review_thread',
  'request_copilot_review',
  'update_issue_comment',
  'run_secret_scanning',
  'issue_dependency_write',
  'disable_pr_auto_merge',
  // CI の AI レビュー（.github/workflows/ai-review.yml）の github_inline_comment のサーバーが、インラインの指摘を付けるのに使う
  'create_inline_comment',
]);

// マージで base を動かすツール。MCP の入力に base は無いので、宛先を問わずに止める
const MERGES = new Set(['merge_pull_request', 'enable_pr_auto_merge']);

// release、tag を語に持つツール（今の MCP の書き込みには無い。足されたときに素通りさせない）。stage などの語の一部には当てない
const RELEASE_TOOL = /(^|_)(releases?|tags?)(_|$)/;

// ブランチの名前を、大文字小文字をそろえて正規化する。GitHub の ref の API は大文字小文字を区別する（heads/Main は 404）が、
// Workers Builds などのブランチの照合が区別するかは確かめていないので、止める側に倒す。
// refs/heads/ と heads/ は外す。判定できない形なら undefined
function branchName(value) {
  if (typeof value !== 'string') return undefined;
  // 先頭の / は外してから見る（//production も production とみなす）
  const name = value.trim().toLowerCase().replace(/^\/+/, '');
  // 制御文字、パーセントエンコード、\、. と .. の区切り、// は、字面の判定を外れうる
  if (name === '' || /[\u0000-\u001f\u007f%\\]/.test(name) || /(^|\/)\.\.?(\/|$)|\/\//.test(name)) return undefined;
  // 先頭の / と、前置きを何段重ねても外す。GitHub は refs/heads//main を refs/heads/main に解くので、/main も main とみなす。
  // refs/heads/refs/heads/main も main とみなし、止める側に倒す
  let short = name;
  for (let prev = ''; prev !== short; ) {
    prev = short;
    short = short.replace(/^\/+/, '').replace(/^refs\/heads\//, '').replace(/^heads\//, '');
  }
  if (short === '') return undefined;
  return short;
}

// ファイルを書くツールの宛先のうち、.github/ の下（ワークフロー、CODEOWNERS、Actions の設定）。
// 作業ブランチに置いたワークフローは push で動き、トークンの権限しだいで production を進めうるので、人が確かめる
function touchesGithubDir(input) {
  const paths = [input?.path, ...(Array.isArray(input?.files) ? input.files.map((file) => file?.path) : [])];
  return paths.some((value) => {
    if (value === undefined) return false;
    if (typeof value !== 'string') return true;
    const normalized = value.trim().replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '').toLowerCase();
    return normalized.startsWith('.github/') || normalized === '.github' || /(^|\/)\.\.?(\/|$)/.test(normalized);
  });
}

// ブランチの名前の引数が、タグを指しているか（MCP の branch はブランチを受けるが、ref の形で渡されたときに備える）
const isTagRef = (name) => /^(refs\/)?tags\//.test(name);

function judgeBranch(value) {
  const name = branchName(value);
  if (name === undefined) return [ASK, UNREADABLE_REASON];
  if (isTagRef(name)) return [DENY, RELEASE_REASON];
  if (name === 'main') return [DENY, MAIN_REASON];
  if (name === 'production') return [DENY, PRODUCTION_REASON];
  return null;
}

function judgeBase(value, required) {
  // 任意の base は、無い、null、空文字を「付け替えない」とみなす
  if (!required && (value === undefined || value === null || value === '')) return null;
  const name = branchName(value);
  if (name === undefined) return [ASK, UNREADABLE_REASON];
  if (isTagRef(name)) return [DENY, RELEASE_REASON];
  if (name === 'production') return [DENY, PRODUCTION_REASON];
  return null;
}

// toolName は mcp__<サーバー>__<ツール>。サーバーの名前に github を含むもの（大文字小文字を問わない。手元で別名で登録したもの、
// プラグインの mcp__plugin_github_github__、claude.ai のコネクタの mcp__claude_ai_GitHub__ も）だけを見る。止めるものが無ければ null
export function judgeMcp(toolName, input) {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName ?? '');
  if (!match || !/github/i.test(match[1])) return null;
  const tool = match[2];
  if (READ_ONLY.test(tool)) return null;
  if (BRANCH_WRITES.has(tool)) {
    const verdict = judgeBranch(input?.[BRANCH_WRITES.get(tool)]);
    if (verdict) return verdict;
    return tool !== 'create_branch' && touchesGithubDir(input) ? [ASK, GITHUB_DIR_REASON] : null;
  }
  if (BASE_WRITES.has(tool)) {
    const { key, required } = BASE_WRITES.get(tool);
    return judgeBase(input?.[key], required);
  }
  if (MERGES.has(tool)) return [DENY, MERGE_REASON];
  if (RELEASE_TOOL.test(tool)) return [DENY, RELEASE_REASON];
  if (SAFE_WRITES.has(tool)) return null;
  return [ASK, UNKNOWN_WRITE_REASON];
}
