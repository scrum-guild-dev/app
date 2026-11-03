// 組織を画面に出すときの名前と、自分用の組織を持つかの判定。自分用（kind が personal）の組織は、組織の行の名前でなく
// 辞書の「自分用」で出す（名前は固定だが、画面が語を辞書から引く決まりのため）。組織の名前を出す画面が通す
import type { OrganizationKind } from '../shared/organization-kind.ts';
import { word } from '../shared/vocabulary.ts';

export function organizationLabel(organization: { name: string; kind: OrganizationKind }): string {
  return organization.kind === 'personal' ? word('personalOrganizationName') : organization.name;
}

// 入れる組織か停止した組織に、自分用が1つでもあるか。あれば「自分用を作る」の入口を出さない
export function hasPersonalOrganization(lists: readonly (readonly { kind: OrganizationKind }[])[]): boolean {
  return lists.some((list) => list.some((organization) => organization.kind === 'personal'));
}
