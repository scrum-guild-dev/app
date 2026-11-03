import { describe, expect, test } from 'vitest';
import type { ErrorBody } from '../shared/errors.ts';
import {
  createPersonalOrganizationFailure,
  validateCreatePersonalOrganization,
} from './create-personal-organization-form.ts';

const failed = (status: number, code: string, details?: unknown) => ({
  ok: false as const,
  status,
  error: { code, message: 'x', ...(details === undefined ? {} : { details }) } as ErrorBody['error'],
});

describe('validateCreatePersonalOrganization', () => {
  test('通る入力は誤りなし。前後の空白は除いてから見る', () => {
    expect(validateCreatePersonalOrganization({ slug: 'solo-mio' })).toBeNull();
    expect(validateCreatePersonalOrganization({ slug: '  solo-mio ' })).toBeNull();
  });

  test('slug が空、形違い、予約名はそれぞれの理由で slug の欄に出す', () => {
    expect(validateCreatePersonalOrganization({ slug: ' ' })).toEqual({
      field: 'slug',
      key: 'createMyOrganizationSlugRequired',
    });
    expect(validateCreatePersonalOrganization({ slug: 'Solo' })).toEqual({
      field: 'slug',
      key: 'createMyOrganizationSlugFormat',
    });
    expect(validateCreatePersonalOrganization({ slug: 'login' })).toEqual({
      field: 'slug',
      key: 'createMyOrganizationSlugReserved',
    });
  });
});

describe('createPersonalOrganizationFailure', () => {
  test('409 の slug_taken は slug の欄、personal_limit は枠に出す', () => {
    expect(createPersonalOrganizationFailure(failed(409, 'conflict', { reason: 'slug_taken' }))).toEqual({
      field: 'slug',
      key: 'createMyOrganizationSlugTaken',
    });
    expect(createPersonalOrganizationFailure(failed(409, 'conflict', { reason: 'personal_limit' }))).toEqual({
      field: 'form',
      key: 'createPersonalOrganizationLimit',
    });
  });

  test('400 は details の path が slug なら slug の欄、それ以外は枠', () => {
    expect(
      createPersonalOrganizationFailure(failed(400, 'invalid_input', [{ path: 'slug', code: 'slug_reserved' }])),
    ).toEqual({ field: 'slug', key: 'createMyOrganizationSlugReserved' });
    expect(
      createPersonalOrganizationFailure(failed(400, 'invalid_input', [{ path: 'slug', code: 'slug_format' }])),
    ).toEqual({ field: 'slug', key: 'createMyOrganizationSlugFormat' });
    expect(createPersonalOrganizationFailure(failed(400, 'invalid_input', [{ path: 'x' }]))).toEqual({
      field: 'form',
      key: 'createMyOrganizationInvalid',
    });
  });

  test('429 と、それ以外の失敗は枠に出す', () => {
    expect(createPersonalOrganizationFailure(failed(429, 'rate_limited'))).toEqual({
      field: 'form',
      key: 'createMyOrganizationRateLimited',
    });
    expect(createPersonalOrganizationFailure(failed(500, 'internal'))).toEqual({
      field: 'form',
      key: 'createPersonalOrganizationFailed',
    });
    expect(createPersonalOrganizationFailure(failed(409, 'conflict'))).toEqual({
      field: 'form',
      key: 'createPersonalOrganizationFailed',
    });
  });
});
