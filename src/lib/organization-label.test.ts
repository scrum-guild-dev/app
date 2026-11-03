import { describe, expect, test } from 'vitest';
import { PERSONAL_ORGANIZATION_NAME } from '../shared/organization-kind.ts';
import { word } from '../shared/vocabulary.ts';
import { hasPersonalOrganization, organizationLabel } from './organization-label.ts';

describe('organizationLabel', () => {
  test('チーム用は組織の名前、自分用は辞書の「自分用」', () => {
    expect(organizationLabel({ name: 'あおば開発', kind: 'team' })).toBe('あおば開発');
    expect(organizationLabel({ name: 'どんな名前でも', kind: 'personal' })).toBe('自分用');
  });
});

describe('自分用の組織の名前', () => {
  // サーバーが組織を作るときに入れる固定の名前（PERSONAL_ORGANIZATION_NAME）と、画面が出す辞書の語は別々に定義されている。
  // 値がずれると、画面の名前と組織の行の名前が食い違うので、同じ値であることを縛る
  test('作るときに入れる固定の名前と、辞書の「自分用」は同じ値', () => {
    expect(PERSONAL_ORGANIZATION_NAME).toBe(word('personalOrganizationName'));
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
