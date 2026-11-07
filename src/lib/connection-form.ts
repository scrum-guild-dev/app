// 接続の画面（connections/+page.svelte）の、登録・範囲の候補・範囲の保存の失敗の振り分け。
// 画面の状態を持たない関数だけを置く（$app を読まないので、node で試せる）。文言は言葉の辞書から出す
import type { ApiResult } from './api.ts';
import { connectionNameProblem } from '../shared/operations/connection/index.ts';
import type { DictionaryKey } from '../shared/vocabulary.ts';

type FailedResult = Extract<ApiResult<unknown>, { ok: false }>;

export type ConnectionField = 'name' | 'credential' | 'form';
// refocus は、失敗の後にフォーカスを戻す欄。認証情報は送った直後に欄から消してあるので、やり直せる失敗は入れ直す欄に戻す
export type ConnectionFailure = { field: ConnectionField; key: DictionaryKey; refocus?: 'name' | 'credential' };

// 送る前の確かめ。サーバーも同じ確かめをする（ここは入力の誤りをすぐ知らせるため）。形の検査は取り込み元の型が行うので、
// ここでは認証情報が空かどうかだけを見る
export function validateConnectionCreate(input: { name: string; credential: string }): ConnectionFailure | null {
  const name = input.name.trim();
  if (name === '') return { field: 'name', key: 'connectionNameRequired' };
  const problem = connectionNameProblem(name);
  if (problem === 'required') return { field: 'name', key: 'connectionNameRequired' };
  if (problem === 'invalid_character') return { field: 'name', key: 'connectionNameInvalid' };
  if (problem === 'too_long') return { field: 'name', key: 'connectionNameTooLong' };
  if (input.credential.trim() === '') return { field: 'credential', key: 'connectionCredentialRequired' };
  return null;
}

// 400 の details のうち、path が引数の項目の code
function codeOf(result: FailedResult, path: string): string | undefined {
  const details = result.error?.details;
  if (!Array.isArray(details)) return undefined;
  for (const item of details as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    if ('path' in item && item.path === path && 'code' in item && typeof item.code === 'string') return item.code;
  }
  return undefined;
}

// 登録（connection-create）の失敗。400 は認証情報の形（credential_shape）と取り込み元が受け付けなかった（credential_rejected）で、
// どちらも登録されず、認証情報の欄に理由を出す。届かない（503、通信できない）は何も登録されていないので、トークンを入れ直してもう一度試せる。
// 409 の workspace_closed と connection_limit は枠に出す。ログインが切れた（401）は呼び出し側が画面ごと移すので、ここへ渡さない
export function connectionCreateFailure(result: FailedResult): ConnectionFailure {
  if (result.status === 400) {
    const code = codeOf(result, 'credential');
    if (code === 'credential_shape') return { field: 'credential', key: 'connectionCredentialShape' };
    if (code === 'credential_rejected') return { field: 'credential', key: 'connectionCredentialRejected' };
    // 長すぎるなど、入力の上限で断られた認証情報も、形が違うものとして欄に出す
    if (code !== undefined) return { field: 'credential', key: 'connectionCredentialShape' };
    const nameCode = codeOf(result, 'name');
    if (nameCode === 'too_big') return { field: 'name', key: 'connectionNameTooLong' };
    if (nameCode === 'too_small') return { field: 'name', key: 'connectionNameRequired' };
    if (nameCode !== undefined) return { field: 'name', key: 'connectionNameInvalid' };
    return { field: 'form', key: 'connectionCreateInvalid' };
  }
  if (result.error?.code === 'workspace_closed') return { field: 'form', key: 'connectionWorkspaceClosed' };
  if (result.status === 409) return { field: 'form', key: 'connectionLimit' };
  // 認証情報は送った直後に欄から消してあるので、やり直すときは入れ直す
  if (result.status === 429) return { field: 'form', key: 'connectionCreateRateLimited', refocus: 'credential' };
  if (result.status === 0 || result.status === 503) {
    return { field: 'form', key: 'connectionCreateUnreachable', refocus: 'credential' };
  }
  return { field: 'form', key: 'connectionCreateFailed', refocus: 'credential' };
}

// 範囲の候補（connection-scope-candidates）と保存（connection-scopes-save）の失敗。
// 候補の 409（credential_rejected）は、保存した認証情報を取り込み元が受け付けなくなったこと
export function connectionScopeFailure(result: FailedResult): DictionaryKey {
  if (result.error?.code === 'workspace_closed') return 'connectionWorkspaceClosed';
  if (result.status === 409) return 'connectionScopeRejected';
  if (result.status === 403 || result.status === 404) return 'connectionScopeGone';
  if (result.status === 400) return 'connectionScopeInvalid';
  if (result.status === 429) return 'connectionRateLimited';
  if (result.status === 0 || result.status === 503) return 'connectionUnreachable';
  return 'connectionScopeFailed';
}

// 「今すぐ同期」（connection-sync）の結果の文言。届いた件数、上限で止めたか、範囲が空、止まった、取り込み元の不調を振り分ける
export function connectionSyncOutcome(data: {
  result: 'success' | 'no_scope' | 'auth_failed' | 'error';
  imported: number;
  more: boolean;
}): { key: DictionaryKey; icon: 'check' | 'alert' } {
  if (data.result === 'no_scope') return { key: 'connectionSyncNoScope', icon: 'alert' };
  if (data.result === 'auth_failed') return { key: 'connectionSyncAuthFailed', icon: 'alert' };
  if (data.result === 'error') return { key: 'connectionSyncError', icon: 'alert' };
  if (data.more) return { key: 'connectionSyncMore', icon: 'check' };
  return { key: data.imported === 0 ? 'connectionSyncNone' : 'connectionSyncDone', icon: 'check' };
}

// 「今すぐ同期」が断られた理由。5分以内の再押しは 429、止まっている接続は 409（connection_stopped）
export function connectionSyncFailure(result: FailedResult): DictionaryKey {
  if (result.error?.code === 'workspace_closed') return 'connectionWorkspaceClosed';
  if (result.status === 429) return 'connectionSyncRateLimited';
  if (result.status === 409) return 'connectionSyncStopped';
  if (result.status === 403 || result.status === 404) return 'connectionSyncGone';
  if (result.status === 0 || result.status === 503) return 'connectionUnreachable';
  return 'connectionSyncFailed';
}
