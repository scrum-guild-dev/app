import { describe, expect, it } from 'vitest';
import type { ApiResult } from './api.ts';
import {
  connectionCreateFailure,
  connectionScopeFailure,
  connectionSyncFailure,
  connectionSyncOutcome,
  validateConnectionCreate,
} from './connection-form.ts';

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

  it('読めない 400 と、そのほかの失敗は枠の理由にする', () => {
    expect(connectionCreateFailure(failed(400, 'invalid_input', [{ path: 'x' }]))).toEqual({
      field: 'form',
      key: 'connectionCreateInvalid',
    });
    expect(connectionCreateFailure(failed(409, 'workspace_closed')).key).toBe('connectionWorkspaceClosed');
    expect(connectionCreateFailure(failed(409, 'conflict', { reason: 'connection_limit' })).key).toBe(
      'connectionLimit',
    );
    expect(connectionCreateFailure(failed(429, 'rate_limited')).key).toBe('connectionRateLimited');
    expect(connectionCreateFailure(failed(503, 'unavailable')).key).toBe('connectionUnreachable');
    expect(connectionCreateFailure(failed(0, null)).key).toBe('connectionUnreachable');
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

describe('connectionSyncOutcome / connectionSyncFailure', () => {
  it('結果を文言に振り分ける', () => {
    const base = { imported: 0, more: false };
    expect(connectionSyncOutcome({ ...base, result: 'success', imported: 3 }).key).toBe('connectionSyncDone');
    expect(connectionSyncOutcome({ ...base, result: 'success' }).key).toBe('connectionSyncNone');
    expect(connectionSyncOutcome({ result: 'success', imported: 3, more: true }).key).toBe('connectionSyncMore');
    expect(connectionSyncOutcome({ ...base, result: 'no_scope' }).key).toBe('connectionSyncNoScope');
    expect(connectionSyncOutcome({ ...base, result: 'auth_failed' })).toEqual({
      key: 'connectionSyncAuthFailed',
      icon: 'alert',
    });
    expect(connectionSyncOutcome({ ...base, result: 'error' }).key).toBe('connectionSyncError');
  });

  it('断られた理由を振り分ける', () => {
    expect(connectionSyncFailure(failed(429, 'rate_limited'))).toBe('connectionSyncRateLimited');
    expect(connectionSyncFailure(failed(409, 'conflict', { reason: 'connection_stopped' }))).toBe(
      'connectionSyncStopped',
    );
    expect(connectionSyncFailure(failed(409, 'workspace_closed'))).toBe('connectionWorkspaceClosed');
    expect(connectionSyncFailure(failed(403, 'forbidden'))).toBe('connectionScopeGone');
    expect(connectionSyncFailure(failed(503, 'unavailable'))).toBe('connectionUnreachable');
    expect(connectionSyncFailure(failed(500, 'internal'))).toBe('connectionSyncFailed');
  });
});
