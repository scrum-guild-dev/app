import { describe, expect, test } from 'vitest';
import { workspaceLimitDetailsOf } from './workspace-limit-details.ts';

describe('workspaceLimitDetailsOf', () => {
  test('used と limit が数なら取り出す', () => {
    expect(workspaceLimitDetailsOf({ used: 3, limit: 3 })).toEqual({ used: 3, limit: 3 });
  });

  test('details が無い、形が違う、値が数でない、負の数は undefined', () => {
    expect(workspaceLimitDetailsOf(undefined)).toBeUndefined();
    expect(workspaceLimitDetailsOf(null)).toBeUndefined();
    expect(workspaceLimitDetailsOf('3')).toBeUndefined();
    expect(workspaceLimitDetailsOf({ used: 3 })).toBeUndefined();
    expect(workspaceLimitDetailsOf({ used: '3', limit: 3 })).toBeUndefined();
    expect(workspaceLimitDetailsOf({ used: -1, limit: 3 })).toBeUndefined();
    expect(workspaceLimitDetailsOf({ used: 1.5, limit: 3 })).toBeUndefined();
  });
});
