// GitHub の MCP のツール（mcp__github__*）の判定。guard-bash.mjs が Bash で止める、main と production と v* のタグと
// Release の書き換えを、MCP の経路でも止める（docs/development.md の「`main` を守る仕組み」）。
// MCP のツールは Bash のフックに掛からないので、ここで見る。読むだけのツールは判定しない。

const DENY = 'deny';
const ASK = 'ask';

const MAIN_REASON = 'main には直接書かない。作業ブランチで作り PR を通す（CLAUDE.md の「守ること」）';
const PRODUCTION_REASON =
  'production は Release のワークフローだけが進める。セッションは書かない（docs/development.md の「ブランチ戦略」）';
const RELEASE_TAG_REASON =
  'v* のタグは人が Release の publish で作る。セッションは作らない（docs/development.md の「ブランチ戦略」）';
const RELEASE_REASON =
  'Release とタグの作成、編集、publish、削除は人が行う。本番に出るのは人の publish だけ（docs/development.md の「リリース」）';
const MERGE_REASON =
  'MCP からはマージしない。マージは作業ブランチの中で gh pr merge --squash --match-head-commit <head の40桁の SHA> を打つか、人が行う（docs/development.md の「マージの判定」）';
const UNREADABLE_REASON = 'ブランチの名前を字面で判定できない（文字列でない、エンコードや . と .. の区切りがある）。人が確かめる';
const UNKNOWN_WRITE_REASON =
  '判定を知らない GitHub の MCP の書き込みのツール。main、production、v* のタグ、Release に触れるかを人が確かめる';

// 読むだけのツール。get_、list_、search_ で始まるもの（get_me なども含む）、_read で終わるもの（issue_read、
// pull_request_read、issue_dependency_read）、actions_get と actions_list
const READ_ONLY = /^(get|list|search)_|_read$|^actions_(get|list)$/;

// ブランチを書き換えるツールと、ブランチの名前を受ける引数。値が main、production、v* なら止める
const BRANCH_WRITES = {
  push_files: ['branch'],
  create_or_update_file: ['branch'],
  delete_file: ['branch'],
  create_branch: ['branch'],
};

// PR の base を受けるツール。base が production の PR は、マージで production を進める
const BASE_WRITES = {
  create_pull_request: ['base'],
  update_pull_request: ['base'],
};

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
]);

// マージで base を動かすツール。MCP の入力に base は無いので、宛先を問わずに止める
const MERGES = new Set(['merge_pull_request', 'enable_pr_auto_merge']);

// ブランチの名前を正規化する。判定できない形なら undefined
function branchName(value) {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  // 制御文字、パーセントエンコード、. と .. の区切り、// は、字面の判定を外れうる
  if (name === '' || /[\u0000-\u001f\u007f%\\]/.test(name) || /(^|\/)\.\.?(\/|$)|\/\//.test(name)) return undefined;
  return name;
}

// main、production、v* のタグに当たるか。当たれば理由を返す
function protectedRef(name) {
  const tagged = /^(refs\/)?tags\//.test(name);
  const short = name.replace(/^refs\/heads\//, '').replace(/^heads\//, '');
  if (tagged) return /^(refs\/)?tags\/v/.test(name) ? RELEASE_TAG_REASON : RELEASE_REASON;
  if (short === 'main') return MAIN_REASON;
  if (short === 'production') return PRODUCTION_REASON;
  // refs/heads/ を付けない v<数字> はタグと紛れる（Bash の判定と同じ）
  if (!/^refs\/heads\//.test(name) && /^v\d/.test(short)) return RELEASE_TAG_REASON;
  return undefined;
}

// 引数の名前の一覧から、止める理由を探す。必須の引数が無いか読めなければ確認を挟む
function judgeRefs(input, keys, { required }) {
  for (const key of keys) {
    const value = input?.[key];
    if (value === undefined && !required) continue;
    const name = branchName(value);
    if (name === undefined) return [ASK, UNREADABLE_REASON];
    const reason = protectedRef(name);
    if (reason) return [DENY, reason];
  }
  return null;
}

// toolName は mcp__<サーバー>__<ツール>。GitHub のサーバーのツールだけを見る。止めるものが無ければ null
export function judgeMcp(toolName, input) {
  const match = /^mcp__github__(.+)$/.exec(toolName ?? '');
  if (!match) return null;
  const tool = match[1];
  if (READ_ONLY.test(tool)) return null;
  if (BRANCH_WRITES[tool]) return judgeRefs(input, BRANCH_WRITES[tool], { required: true });
  if (BASE_WRITES[tool]) return judgeRefs(input, BASE_WRITES[tool], { required: tool === 'create_pull_request' });
  if (MERGES.has(tool)) return [DENY, MERGE_REASON];
  // release、tag を名前に持つ書き込み（今の MCP には無い。足されたときに素通りさせない）
  if (/release|tag/.test(tool)) return [DENY, RELEASE_REASON];
  if (SAFE_WRITES.has(tool)) return null;
  return [ASK, UNKNOWN_WRITE_REASON];
}
