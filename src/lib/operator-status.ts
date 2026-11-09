import type { OutputOf } from '../shared/operations/define.ts';
import type { listOrganizations } from '../shared/operations/operator/list-organizations.ts';

type Organization = OutputOf<typeof listOrganizations>['organizations'][number];
type StatusInput = Pick<
  Organization,
  'kind' | 'trial_ends_on' | 'trial_expired' | 'suspended_at' | 'purge_on' | 'admin_status'
>;

const states = {
  trialExpired: { label: 'operatorStatusTrialExpired', tone: 'danger', icon: 'alert' },
  cancellation: { label: 'operatorStatusCancellation', tone: 'danger', icon: 'alert' },
  adminNone: { label: 'operatorStatusAdminNone', tone: 'danger', icon: 'alert' },
  adminExpired: { label: 'operatorStatusAdminExpired', tone: 'danger', icon: 'alert' },
  suspended: { label: 'operatorStatusSuspended', tone: 'warn', icon: 'clock' },
  adminPending: { label: 'operatorStatusAdminPending', tone: 'warn', icon: 'clock' },
} as const;

// 危険な状態を先にし、最初の1つを要約に見せる。残りも読み上げに残す。
// 見本の対応箇所は design/operator.html の organizationStatuses。
export function operatorStatuses(organization: StatusInput) {
  const active: (keyof typeof states)[] = [];
  if (organization.trial_ends_on !== null && organization.trial_expired) active.push('trialExpired');
  if (organization.suspended_at && organization.purge_on) active.push('cancellation');
  if (organization.kind !== 'personal' && organization.admin_status === 'none') active.push('adminNone');
  if (organization.kind !== 'personal' && organization.admin_status === 'expired') active.push('adminExpired');
  if (organization.suspended_at) active.push('suspended');
  if (organization.kind !== 'personal' && organization.admin_status === 'pending') active.push('adminPending');
  return active.map((code) => ({ code, ...states[code] }));
}
