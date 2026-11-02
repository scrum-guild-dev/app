import { describe, expect, test } from 'vitest';
import { hasPersonalOrganization, organizationLabel } from './organization-label.ts';

describe('organizationLabel', () => {
  test('チーム用は組織の名前、自分用は辞書の「自分用」', () => {
    expect(organizationLabel({ name: 'あおば開発', kind: 'team' })).toBe('あおば開発');
    expect(organizationLabel({ name: 'どんな名前でも', kind: 'personal' })).toBe('自分用');
  });
});

describe('hasPersonalOrganization', () => {
  test('入れる組織にも停止した組織にも自分用が無ければ偽', () => {
    expect(hasPersonalOrganization([[], []])).toBe(false);
    expect(hasPersonalOrganization([[{ kind: 'team' }], [{ kind: 'team' }]])).toBe(false);
  });

  test('どちらか一方に自分用があれば真', () => {
    expect(hasPersonalOrganization([[{ kind: 'team' }, { kind: 'personal' }], []])).toBe(true);
    expect(hasPersonalOrganization([[], [{ kind: 'personal' }]])).toBe(true);
  });
});
