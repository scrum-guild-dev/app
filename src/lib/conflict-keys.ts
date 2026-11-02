// 409 の conflict の理由（details.reason）を、画面に出す辞書のキーに写す。副作用は部品が行い、ここは写すだけ
import { reassignAdminConflictReasonOf } from '../shared/operations/operator/index.ts';
import { userConflictReasonOf } from '../shared/operations/organization/user.ts';
import type { DictionaryKey } from '../shared/vocabulary.ts';

// ユーザーの操作（管理者の指名と解除、無効化、有効に戻す）。member_limit_reached は code が別で、ここには来ない。
// 理由が読めない 409 は、読んでから書くまでに相手が変わったものとして扱う
export function userConflictKeyOf(details: unknown): DictionaryKey {
  switch (userConflictReasonOf(details)) {
    case 'last_admin':
      return 'userErrorLastAdmin';
    case 'self':
      return 'userErrorSelf';
    case 'disabled':
      return 'userErrorDisabled';
    case 'member_limit':
      return 'userErrorMemberLimit';
    case 'personal_organization':
      return 'userErrorPersonalOrganization';
    default:
      return 'userErrorChanged';
  }
}

// 運用者の管理者の指名し直し。自分用の組織は、もう一度試しても通らない（再試行を促さない文言）。
// 理由の無い 409 は、読んでから書くまでに同じ人の行が変わった
export function reassignConflictKeyOf(details: unknown): DictionaryKey {
  return reassignAdminConflictReasonOf(details) === 'personal_organization'
    ? 'operatorReassignPersonal'
    : 'operatorReassignConflict';
}
