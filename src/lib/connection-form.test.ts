import { describe, expect, it } from 'vitest';
import type { ApiResult } from './api.ts';
import { connectionCreateFailure, connectionScopeFailure, validateConnectionCreate } from './connection-form.ts';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const failed = (status: number, code: string | null, details?: unknown): Failed => ({
  ok: false,
  status,
  error: code === null ? null : ({ code, message: '', details } as NonNullable<Failed['error']>),
});

describe('validateConnectionCreate', () => {
  it('表示名と認証情報の空を断る', () => {
    expect(validateConnectionCreate({ name: ' ', credential: 'x' })).toEqual({
      field: 'name',
      key: 'connectionNameRequired',
    });
    expect(validateConnectionCreate({ name: 'a'.repeat(51), credential: 'x' })).toEqual({
      field: 'name',
      key: 'connectionNameTooLong',
    });
    // 見えない文字だけ・向きを変える制御文字は「50字まで」でなく、それぞれの理由にする
    expect(validateConnectionCreate({ name: '\u200b', credential: 'x' })).toEqual({
      field: 'name',
      key: 'connectionNameRequired',
    });
    expect(validateConnectionCreate({ name: 'a\u202eb', credential: 'x' })).toEqual({
      field: 'name',
      key: 'connectionNameInvalid',
    });
    expect(validateConnectionCreate({ name: 'a', credential: ' ' })).toEqual({
      field: 'credential',
      key: 'connectionCredentialRequired',
    });
    expect(validateConnectionCreate({ name: 'a'.repeat(50), credential: 'x' })).toBeNull();
  });
});

describe('connectionCreateFailure', () => {
  it('形の違う認証情報と受け付けられない認証情報は、認証情報の欄の理由にする', () => {
    expect(
      connectionCreateFailure(failed(400, 'invalid_input', [{ path: 'credential', code: 'credential_shape' }])),
    ).toEqual({ field: 'credential', key: 'connectionCredentialShape' });
    expect(
      connectionCreateFailure(failed(400, 'invalid_input', [{ path: 'credential', code: 'credential_rejected' }])),
    ).toEqual({ field: 'credential', key: 'connectionCredentialRejected' });
  });

  it('上限を超えた認証情報（too_big）は、認証情報の欄に出す', () => {
    expect(connectionCreateFailure(failed(400, 'invalid_input', [{ path: 'credential', code: 'too_big' }]))).toEqual({
      field: 'credential',
      key: 'connectionCredentialShape',
    });
  });

  it('読めない 400 と、そのほかの失敗は枠の理由にする', () => {
    expect(connectionCreateFailure(failed(400, 'invalid_input', [{ path: 'x' }]))).toEqual({
      field: 'form',
      key: 'connectionCreateInvalid',
    });
    expect(connectionCreateFailure(failed(409, 'workspace_closed')).key).toBe('connectionWorkspaceClosed');
    expect(connectionCreateFailure(failed(409, 'conflict', { reason: 'connection_limit' })).key).toBe(
      'connectionLimit',
    );
    // 認証情報は欄から消してあるので、やり直しの文言は入れ直しを添える
    expect(connectionCreateFailure(failed(429, 'rate_limited')).key).toBe('connectionCreateRateLimited');
    expect(connectionCreateFailure(failed(503, 'unavailable')).key).toBe('connectionCreateUnreachable');
    expect(connectionCreateFailure(failed(0, null)).key).toBe('connectionCreateUnreachable');
    expect(connectionCreateFailure(failed(500, 'internal')).key).toBe('connectionCreateFailed');
  });
});

describe('connectionScopeFailure', () => {
  it('失敗を理由に振り分ける', () => {
    expect(connectionScopeFailure(failed(409, 'conflict', { reason: 'credential_rejected' }))).toBe(
      'connectionScopeRejected',
    );
    expect(connectionScopeFailure(failed(409, 'workspace_closed'))).toBe('connectionWorkspaceClosed');
    expect(connectionScopeFailure(failed(403, 'forbidden'))).toBe('connectionScopeGone');
    expect(connectionScopeFailure(failed(404, 'not_found'))).toBe('connectionScopeGone');
    expect(connectionScopeFailure(failed(400, 'invalid_input'))).toBe('connectionScopeInvalid');
    expect(connectionScopeFailure(failed(503, 'unavailable'))).toBe('connectionUnreachable');
    expect(connectionScopeFailure(failed(500, 'internal'))).toBe('connectionScopeFailed');
  });
});
