import { describe, expect, test } from 'vitest';
import { classifyInviteFailure } from './invite-failure.ts';

const failed = (status: number, code?: string, details?: unknown) => ({
  ok: false as const,
  status,
  error: code === undefined ? null : { code, details },
});

describe('classifyInviteFailure', () => {
  test('ログインが切れたら login', () => {
    expect(classifyInviteFailure(failed(401, 'unauthenticated'), 'invite', true)).toEqual({ kind: 'login' });
  });

  test('閉じた、権限を失った、見つからないは、トーストで知らせて読み直す', () => {
    expect(classifyInviteFailure(failed(409, 'workspace_closed'), 'invite', true)).toEqual({
      kind: 'reload',
      toast: 'inviteErrorClosed',
    });
    expect(classifyInviteFailure(failed(403, 'forbidden'), 'invite', true)).toEqual({
      kind: 'reload',
      toast: 'inviteErrorForbidden',
    });
    expect(classifyInviteFailure(failed(404, 'not_found'), 'verify', true)).toEqual({
      kind: 'reload',
      toast: 'inviteErrorForbidden',
    });
  });

  test('人数の上限は limit', () => {
    expect(classifyInviteFailure(failed(409, 'member_limit_reached'), 'invite', false)).toEqual({ kind: 'limit' });
  });

  describe('自分用の組織（409 の conflict、reason が personal_organization）', () => {
    const personal = failed(409, 'conflict', { reason: 'personal_organization' });

    test('招待の送信は、欄ではなく枠に、再試行を促さない文言を出し、読み直さない', () => {
      for (const github of [true, false]) {
        expect(classifyInviteFailure(personal, 'invite', github)).toEqual({
          kind: 'field',
          field: 'form',
          key: 'invitePersonalRefused',
          refresh: false,
        });
      }
    });

    test('ユーザー名の確かめ（invitee-resolve）でも同じ', () => {
      expect(classifyInviteFailure(personal, 'verify', true)).toEqual({
        kind: 'field',
        field: 'form',
        key: 'invitePersonalRefused',
        refresh: false,
      });
    });

    test('reason が違う 409 の conflict は、自分用として扱わない', () => {
      expect(classifyInviteFailure(failed(409, 'conflict', { reason: 'other' }), 'invite', true)).toMatchObject({
        key: 'inviteErrorFailed',
        refresh: true,
      });
      expect(classifyInviteFailure(failed(409, 'conflict'), 'verify', true)).toMatchObject({
        key: 'inviteErrorVerifyFailed',
      });
    });
  });

  test('人を指す欄の誤りは、GitHub ではユーザー名、Google ではメールアドレスの欄に出す', () => {
    const notFound = failed(400, 'invalid_input', [{ path: 'username', code: 'github_user_not_found' }]);
    expect(classifyInviteFailure(notFound, 'verify', true)).toMatchObject({
      field: 'username',
      key: 'inviteErrorUserNotFound',
    });
    expect(classifyInviteFailure(notFound, 'invite', false)).toMatchObject({
      field: 'email',
      key: 'inviteErrorUserNotFound',
    });
    const email = failed(400, 'invalid_input', [{ path: 'email', code: 'email_invalid' }]);
    expect(classifyInviteFailure(email, 'invite', false)).toMatchObject({
      field: 'email',
      key: 'inviteErrorEmailInvalid',
    });
  });

  test('所属している、招待済みは一覧を読み直し、持ち主が変わったは読み直さない', () => {
    expect(classifyInviteFailure(failed(409, 'already_member'), 'invite', true)).toEqual({
      kind: 'field',
      field: 'username',
      key: 'inviteErrorAlreadyMember',
      refresh: true,
    });
    expect(classifyInviteFailure(failed(409, 'already_invited'), 'invite', false)).toMatchObject({
      field: 'email',
      key: 'inviteErrorAlreadyInvited',
      refresh: true,
    });
    expect(classifyInviteFailure(failed(409, 'invitee_changed'), 'invite', true)).toMatchObject({
      key: 'inviteErrorUserChanged',
      refresh: false,
    });
  });

  test('回数の上限は、確かめでは欄に、招待の送信では枠に出す', () => {
    expect(classifyInviteFailure(failed(429, 'rate_limited'), 'verify', true)).toMatchObject({
      field: 'username',
      key: 'inviteErrorTooMany',
    });
    expect(classifyInviteFailure(failed(429, 'rate_limited'), 'invite', true)).toMatchObject({
      field: 'form',
      key: 'inviteErrorTooManyInvites',
    });
  });

  test('GitHub に届かないのは、GitHub のときだけ。Google では招待できたか分からない失敗として扱う', () => {
    expect(classifyInviteFailure(failed(503, 'unavailable'), 'verify', true)).toMatchObject({
      field: 'username',
      key: 'inviteErrorGithubUnavailable',
    });
    expect(classifyInviteFailure(failed(503, 'unavailable'), 'invite', true)).toMatchObject({
      field: 'form',
      key: 'inviteErrorGithubUnavailable',
    });
    expect(classifyInviteFailure(failed(503, 'unavailable'), 'invite', false)).toMatchObject({
      key: 'inviteErrorUnknownGoogle',
      refresh: true,
    });
  });

  test('確かめの失敗は読み直さず、招待できたか分からない失敗は読み直す', () => {
    expect(classifyInviteFailure(failed(0), 'verify', true)).toEqual({
      kind: 'field',
      field: 'username',
      key: 'inviteErrorUnreachable',
      refresh: false,
    });
    expect(classifyInviteFailure(failed(500, 'internal'), 'verify', true)).toMatchObject({
      key: 'inviteErrorVerifyFailed',
    });
    expect(classifyInviteFailure(failed(0), 'invite', true)).toEqual({
      kind: 'field',
      field: 'form',
      key: 'inviteErrorUnreachable',
      refresh: true,
    });
    expect(classifyInviteFailure(failed(500, 'internal'), 'invite', true)).toMatchObject({
      key: 'inviteErrorFailed',
      refresh: true,
    });
  });
});
