import { describe, expect, test } from 'vitest';
import { reassignConflictKeyOf, userConflictKeyOf } from './conflict-keys.ts';

describe('userConflictKeyOf', () => {
  test('理由ごとのキーに写し、自分用の組織は再試行を促さない専用のキー', () => {
    expect(userConflictKeyOf({ reason: 'last_admin' })).toBe('userErrorLastAdmin');
    expect(userConflictKeyOf({ reason: 'self' })).toBe('userErrorSelf');
    expect(userConflictKeyOf({ reason: 'disabled' })).toBe('userErrorDisabled');
    expect(userConflictKeyOf({ reason: 'member_limit' })).toBe('userErrorMemberLimit');
    expect(userConflictKeyOf({ reason: 'personal_organization' })).toBe('userErrorPersonalOrganization');
  });

  test('理由が読めない、または一覧に無いときは、相手が変わったものとして扱う', () => {
    expect(userConflictKeyOf(undefined)).toBe('userErrorChanged');
    expect(userConflictKeyOf({})).toBe('userErrorChanged');
    expect(userConflictKeyOf({ reason: 'unknown' })).toBe('userErrorChanged');
  });
});

describe('reassignConflictKeyOf', () => {
  test('自分用の組織は専用のキー、理由の無い 409 は状態が変わったとして扱う', () => {
    expect(reassignConflictKeyOf({ reason: 'personal_organization' })).toBe('operatorReassignPersonal');
    expect(reassignConflictKeyOf(undefined)).toBe('operatorReassignConflict');
    expect(reassignConflictKeyOf({ reason: 'other' })).toBe('operatorReassignConflict');
  });
});
