// 招待の画面（MemberInvite）が、ユーザー名の確かめ（invitee-resolve）と招待の送信（invitation-create）の失敗を、
// どう扱うかに分ける処理。副作用（画面を移す、トースト、読み直し、フォーカス）は部品が行い、ここは応答を種類に写すだけ。
// 順は、ログインが切れた、権限か対象を失った、人数の上限、自分用の組織、人を指す欄の誤り、重なり、回数の上限、GitHub に届かない、
// 確かめの失敗、招待できたか分からない失敗
import { invitationCreateConflictReasonOf } from '../shared/operations/workspace/invitation-create.ts';
import type { DictionaryKey } from '../shared/vocabulary.ts';
import { isUnauthenticated } from './login-redirect.ts';

export type InviteField = 'username' | 'email' | 'form';
// ユーザー名を確かめる（verify）か、招待を送る（invite）か
export type InviteContext = 'verify' | 'invite';

export type InviteFailure =
  // ログインが切れた。ログインの画面へ移す
  | { kind: 'login' }
  // 閉じた、権限を失った、ワークスペースが見つからない。節ごと消えることがあるので、トーストで知らせて画面を読み直す
  | { kind: 'reload'; toast: 'inviteErrorClosed' | 'inviteErrorForbidden' }
  // 人数が上限に達していて、この人はまだ数えられていない。上限の枠を出して人数を読み直す
  | { kind: 'limit' }
  // 欄に出す失敗。refresh は、承諾待ちの一覧と人数を読み直すか
  | { kind: 'field'; field: InviteField; key: DictionaryKey; refresh: boolean };

type FailedResult = { ok: false; status: number; error: { code: string; details?: unknown } | null };

// 入力の誤りの理由（details の code）と、409 の code を、辞書のキーに写す
const problemKeys: Record<string, DictionaryKey> = {
  github_user_not_found: 'inviteErrorUserNotFound',
  github_not_a_user: 'inviteErrorNotUser',
  email_invalid: 'inviteErrorEmailInvalid',
};
const conflictKeys: Record<string, DictionaryKey> = {
  invitee_changed: 'inviteErrorUserChanged',
  already_member: 'inviteErrorAlreadyMember',
  already_invited: 'inviteErrorAlreadyInvited',
};

function problemCodeOf(result: FailedResult): string | undefined {
  const details = result.error?.details;
  if (!Array.isArray(details)) return undefined;
  for (const item of details as unknown[]) {
    if (typeof item === 'object' && item !== null && 'code' in item && typeof item.code === 'string') {
      if (Object.hasOwn(problemKeys, item.code)) return item.code;
    }
  }
  return undefined;
}

// github は、ログインの手段が GitHub か。人を指す欄は GitHub ならユーザー名、Google ならメールアドレス
export function classifyInviteFailure(result: FailedResult, context: InviteContext, github: boolean): InviteFailure {
  if (isUnauthenticated(result)) return { kind: 'login' };
  const code = result.error?.code;
  if (code === 'workspace_closed' || result.status === 403 || result.status === 404) {
    return { kind: 'reload', toast: code === 'workspace_closed' ? 'inviteErrorClosed' : 'inviteErrorForbidden' };
  }
  if (code === 'member_limit_reached') return { kind: 'limit' };
  // 自分用の組織は1人だけで、招待は何度送っても通らない。再試行を促さず、読み直しもしない
  if (
    result.status === 409 &&
    code === 'conflict' &&
    invitationCreateConflictReasonOf(result.error?.details) === 'personal_organization'
  ) {
    return { kind: 'field', field: 'form', key: 'invitePersonalRefused', refresh: false };
  }
  // 人を指す欄の誤り。Google ではユーザー名の欄が無いので、メールアドレスの欄に出す（出す場所が無いまま消さない）
  const inputField: InviteField = github ? 'username' : 'email';
  const problem = problemCodeOf(result);
  if (problem !== undefined) {
    return {
      kind: 'field',
      field: problem === 'email_invalid' ? 'email' : inputField,
      key: problemKeys[problem]!,
      refresh: false,
    };
  }
  if (code !== undefined && Object.hasOwn(conflictKeys, code)) {
    // 別のリーダーが先に招待したか、承諾されたときは、一覧を読み直して今の所属と招待を出す
    return {
      kind: 'field',
      field: inputField,
      key: conflictKeys[code]!,
      refresh: code === 'already_member' || code === 'already_invited',
    };
  }
  // 回数の上限。招待の送信では、確かめた結果を残したまま、しばらく後に押し直せるようにする
  if (code === 'rate_limited') {
    return context === 'verify'
      ? { kind: 'field', field: 'username', key: 'inviteErrorTooMany', refresh: false }
      : { kind: 'field', field: 'form', key: 'inviteErrorTooManyInvites', refresh: false };
  }
  // GitHub に届かない（Google の招待は GitHub に問い合わせないので、ほかの失敗と同じに扱う）
  if (result.status === 503 && github) {
    return {
      kind: 'field',
      field: context === 'verify' ? 'username' : 'form',
      key: 'inviteErrorGithubUnavailable',
      refresh: false,
    };
  }
  if (context === 'verify') {
    return {
      kind: 'field',
      field: 'username',
      key: result.status === 0 ? 'inviteErrorUnreachable' : 'inviteErrorVerifyFailed',
      refresh: false,
    };
  }
  // 招待できたか分からない失敗（通信の切れ、5xx）。一覧を読み直して、入っていれば見えるようにする。
  // Google では、書かれていても招待の URL はもう出せないので、招待し直すと新しい URL が出ることを添える
  if (!github) return { kind: 'field', field: 'form', key: 'inviteErrorUnknownGoogle', refresh: true };
  return {
    kind: 'field',
    field: 'form',
    key: result.status === 0 ? 'inviteErrorUnreachable' : 'inviteErrorFailed',
    refresh: true,
  };
}
