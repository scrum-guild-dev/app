import { expect, test } from 'vitest';
import { operatorStatuses } from './operator-status.ts';

const regular = {
  kind: 'team' as const,
  trial_ends_on: null,
  trial_expired: false,
  suspended_at: null,
  purge_on: null,
  admin_status: 'active' as const,
};

test('補足のない組織には状態を付けない', () => {
  expect(operatorStatuses(regular)).toEqual([]);
});

test('危険と注意は見える文言とアイコンも異なる', () => {
  const expired = operatorStatuses({ ...regular, trial_ends_on: '2026-10-31', trial_expired: true });
  expect(expired).toEqual([
    { code: 'trialExpired', label: 'operatorStatusTrialExpired', tone: 'danger', icon: 'alert' },
  ]);
  expect(operatorStatuses({ ...regular, suspended_at: '2026-11-01' })).toEqual([
    { code: 'suspended', label: 'operatorStatusSuspended', tone: 'warn', icon: 'clock' },
  ]);
  expect(operatorStatuses({ ...regular, admin_status: 'pending' })).toEqual([
    { code: 'adminPending', label: 'operatorStatusAdminPending', tone: 'warn', icon: 'clock' },
  ]);
});

test('重なった状態を落とさず、危険を先にする', () => {
  expect(
    operatorStatuses({
      ...regular,
      trial_ends_on: '2026-10-31',
      trial_expired: true,
      suspended_at: '2026-11-01',
      purge_on: '2026-12-01',
      admin_status: 'none',
    }).map((status) => status.code),
  ).toEqual(['trialExpired', 'cancellation', 'adminNone', 'suspended']);
});

test('招待期限切れを停止より先に見せ、自分用には管理者の状態を出さない', () => {
  const organization = { ...regular, suspended_at: '2026-11-01', admin_status: 'expired' as const };
  expect(operatorStatuses(organization).map((status) => status.code)).toEqual(['adminExpired', 'suspended']);
  expect(operatorStatuses({ ...organization, kind: 'personal' }).map((status) => status.code)).toEqual(['suspended']);
});

test('期限が無い行と停止していない行に、期限切れや解約を誤って付けない', () => {
  expect(operatorStatuses({ ...regular, trial_expired: true, purge_on: '2026-12-01' })).toEqual([]);
});

test.each(['none', 'pending'] as const)('自分用の%sは管理者の状態を付けない', (admin_status) => {
  expect(operatorStatuses({ ...regular, kind: 'personal', admin_status })).toEqual([]);
});

test('停止中と指名待ちが重なると停止を先に見せる', () => {
  expect(
    operatorStatuses({ ...regular, suspended_at: '2026-11-01', admin_status: 'pending' }).map((status) => status.code),
  ).toEqual(['suspended', 'adminPending']);
});
