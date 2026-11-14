import {
  delegateeCreateOperation,
  delegateeDeleteOperation,
  delegateeListOperation,
  delegateeUpdateOperation,
} from './delegatee.ts';
import { taskDelegateOperation } from './task-delegate.ts';
import { attachmentListOperation, attachmentDeleteOperation } from './attachment-list-delete.ts';
import { favoriteListOperation, favoriteSetOperation } from './favorite.ts';
import { notificationListOperation, notificationReadOperation } from './notification.ts';
import { orgWikiDeleteOperation, workspaceWikiDeleteOperation } from './wiki-delete.ts';
import { orgWikiMoveOperation, workspaceWikiMoveOperation } from './wiki-move.ts';
import { orgWikiUploadOperation, workspaceWikiUploadOperation } from './wiki-upload.ts';
import {
  orgWikiSearchOperation,
  workspaceWikiSearchOperation,
  orgWikiTreeOperation,
  orgWikiPageOperation,
  orgWikiCreateOperation,
  orgWikiUpdateOperation,
  orgWikiRevisionsOperation,
  workspaceWikiRevisionsOperation,
  workspaceWikiTreeOperation,
  workspaceWikiPageOperation,
  workspaceWikiCreateOperation,
  workspaceWikiUpdateOperation,
} from './wiki.ts';
import { thanksSendOperation, thanksRevokeOperation } from './thanks.ts';
// 本番に登録する操作の一覧。定義は src/shared/operations/ に、処理はここに置く（docs/development.md の「操作の定義」）。
// 仮の操作はテストの中で定義し、ここに入れない
import type { ImplementedOperation } from './implement.ts';
import {
  connectionCreateOperation,
  connectionListOperation,
  connectionScopeCandidatesOperation,
  connectionScopesSaveOperation,
  connectionSyncOperation,
} from './connection.ts';
import { attachmentDownloadOperation, attachmentUploadOperation } from './attachment.ts';
import { operationListOperationFor } from './operation-list.ts';
import { backlogCompletedTasksOperation } from './backlog-completed-tasks.ts';
import { experienceGrantsOperation, experienceSummaryOperation, experienceTeamTotalOperation } from './experience.ts';
import { invitationCreateOperation, invitationRevokeOperation, inviteeResolveOperation } from './invitation.ts';
import {
  invitationAcceptOperation,
  invitationDeclineOperation,
  invitationListOperation,
} from './invitation-response.ts';
import { meThemeUpdateOperation } from './me-theme.ts';
import { membershipLeaveOperation, membershipRoleUpdateOperation } from './membership.ts';
import { createOrganizationOperation, listOrganizationsOperation, resolveGithubUserOperation } from './operator.ts';
import { organizationAdminReassignOperation } from './operator-admin.ts';
import { organizationQuotaUpdateOperation } from './operator-quota.ts';
import {
  organizationResumeOperation,
  organizationSuspendOperation,
  organizationSuspensionUpdateOperation,
} from './operator-suspension.ts';
import { createMyOrganizationOperation } from './create-my-organization.ts';
import { createPersonalOrganizationOperation } from './create-personal-organization.ts';
import { myOrganizationsOperation, organizationInfoOperation } from './organization.ts';
import { todayOperation } from './today.ts';
import { firstStepsOperation } from './first-steps.ts';
import { organizationHistoryOperation } from './organization-history.ts';
import {
  organizationHolidayAddOperation,
  organizationHolidayDeleteOperation,
  organizationHolidayListOperation,
} from './organization-holiday.ts';
import { logoutOperation, meOperation } from './session.ts';
import { accountProfileSaveOperation, onboardingStatusOperation } from './onboarding.ts';
import { onboardingWorkspacePrepareOperation } from './onboarding-workspace.ts';
import { consentRecordOperation, consentStatusOperation } from './consent.ts';
import { credentialsRevokeAllOperation } from './credentials.ts';
import { tokenCreateOperation, tokenListOperation, tokenRevokeOperation } from './token.ts';
import { tokenNoticeOperation, tokenNoticeSeenOperation } from './token-notice.ts';
import { userAdminUpdateOperation, userDisableOperation, userEnableOperation, userListOperation } from './user.ts';
import { planSummaryOperation } from './plan-summary.ts';
import { sprintBoardOperation, taskColumnMoveOperation } from './sprint-board.ts';
import { sprintExtendOperation } from './sprint-extend.ts';
import { sprintCloseOperation } from './sprint-close.ts';
import {
  sprintCreateOperation,
  sprintDeleteOperation,
  sprintListOperation,
  sprintStartOperation,
  sprintTaskAddOperation,
  sprintTaskRemoveOperation,
  sprintUpdateOperation,
} from './sprint.ts';
import { epicCreateOperation, epicGetOperation, epicMoveOperation, epicUpdateOperation } from './epic.ts';
import { epicCompleteOperation, epicReopenOperation } from './epic-clear.ts';
import { epicDetailOperation } from './epic-detail.ts';
import { epicPartyAssignOperation, epicPartyJoinOperation, epicPartyLeaveOperation } from './epic-party.ts';
import { epicRequesterUpdateOperation, epicRewardUpdateOperation } from './epic-reward.ts';
import {
  categoryCreateOperation,
  categoryDeleteOperation,
  categoryMoveOperation,
  categoryRepositoryListOperation,
  categoryUpdateOperation,
  detailFieldCreateOperation,
  detailFieldDeleteOperation,
  detailFieldListOperation,
  detailFieldMoveOperation,
  detailFieldUpdateOperation,
  repositoryCreateOperation,
  repositoryDeleteOperation,
  repositoryMoveOperation,
  repositoryUpdateOperation,
} from './definition.ts';
import {
  columnCreateOperation,
  columnDeleteOperation,
  columnListOperation,
  columnMoveOperation,
  columnUpdateOperation,
} from './column.ts';
import {
  storyCompleteOperation,
  storyCreateOperation,
  storyGetOperation,
  storyMoveOperation,
  storyReopenOperation,
  storyUpdateOperation,
} from './story.ts';
import { taskAssignOperation, taskDeleteOperation, taskDetailOperation, taskUpdateOperation } from './task-edit.ts';
import { taskFieldSetOperation } from './task-field.ts';
import { inboxListOperation, inboxToBacklogOperation } from './inbox.ts';
import { taskTodayMarkOperation } from './task-today-mark.ts';
import { taskHistoryOperation } from './task-history.ts';
import {
  commentCreateOperation,
  commentDeleteOperation,
  commentListOperation,
  commentUpdateOperation,
} from './comment.ts';
import { epicDeleteOperation, storyDeleteOperation } from './tree-delete.ts';
import { backlogTreeOperation, taskCompleteOperation, taskCreateOperation, taskMoveOperation } from './task.ts';
import { taskReopenOperation } from './task-reopen.ts';
import { taskRestoreOperation } from './task-restore.ts';
import {
  memberListOperation,
  workspaceCloseOperation,
  workspaceCreateOperation,
  workspaceDodUpdateOperation,
  workspaceInfoOperation,
  workspaceLeaderCandidatesOperation,
  workspaceListOperation,
  workspaceReopenOperation,
} from './workspace.ts';

// 呼べる操作の一覧（operation-list）が載せる、ほかの操作
const listedOperations: readonly ImplementedOperation[] = [
  notificationListOperation,
  notificationReadOperation,
  favoriteListOperation,
  favoriteSetOperation,
  orgWikiDeleteOperation,
  workspaceWikiDeleteOperation,
  orgWikiUploadOperation,
  workspaceWikiUploadOperation,
  orgWikiSearchOperation,
  workspaceWikiSearchOperation,
  orgWikiMoveOperation,
  workspaceWikiMoveOperation,
  orgWikiTreeOperation,
  orgWikiPageOperation,
  orgWikiCreateOperation,
  orgWikiUpdateOperation,
  orgWikiRevisionsOperation,
  workspaceWikiRevisionsOperation,
  workspaceWikiTreeOperation,
  workspaceWikiPageOperation,
  workspaceWikiCreateOperation,
  workspaceWikiUpdateOperation,
  listOrganizationsOperation,
  resolveGithubUserOperation,
  createOrganizationOperation,
  organizationSuspendOperation,
  organizationSuspensionUpdateOperation,
  organizationResumeOperation,
  organizationAdminReassignOperation,
  organizationQuotaUpdateOperation,
  myOrganizationsOperation,
  createMyOrganizationOperation,
  createPersonalOrganizationOperation,
  organizationInfoOperation,
  meThemeUpdateOperation,
  todayOperation,
  firstStepsOperation,
  organizationHolidayListOperation,
  organizationHolidayAddOperation,
  organizationHolidayDeleteOperation,
  organizationHistoryOperation,
  userListOperation,
  userAdminUpdateOperation,
  userDisableOperation,
  userEnableOperation,
  meOperation,
  logoutOperation,
  accountProfileSaveOperation,
  onboardingStatusOperation,
  onboardingWorkspacePrepareOperation,
  consentStatusOperation,
  consentRecordOperation,
  tokenCreateOperation,
  tokenListOperation,
  tokenRevokeOperation,
  tokenNoticeOperation,
  tokenNoticeSeenOperation,
  credentialsRevokeAllOperation,
  epicCreateOperation,
  epicGetOperation,
  epicDetailOperation,
  epicUpdateOperation,
  epicMoveOperation,
  epicPartyJoinOperation,
  epicPartyLeaveOperation,
  epicPartyAssignOperation,
  epicRewardUpdateOperation,
  epicRequesterUpdateOperation,
  epicCompleteOperation,
  epicReopenOperation,
  experienceSummaryOperation,
  experienceGrantsOperation,
  experienceTeamTotalOperation,
  storyCreateOperation,
  storyGetOperation,
  storyUpdateOperation,
  storyMoveOperation,
  storyCompleteOperation,
  storyReopenOperation,
  epicDeleteOperation,
  storyDeleteOperation,
  sprintListOperation,
  sprintCreateOperation,
  sprintUpdateOperation,
  sprintDeleteOperation,
  sprintTaskAddOperation,
  sprintTaskRemoveOperation,
  sprintStartOperation,
  sprintCloseOperation,
  sprintExtendOperation,
  sprintBoardOperation,
  planSummaryOperation,
  taskColumnMoveOperation,
  taskCreateOperation,
  backlogTreeOperation,
  backlogCompletedTasksOperation,
  inboxListOperation,
  inboxToBacklogOperation,
  taskCompleteOperation,
  taskReopenOperation,
  taskDelegateOperation,
  delegateeCreateOperation,
  delegateeDeleteOperation,
  delegateeListOperation,
  delegateeUpdateOperation,
  taskDetailOperation,
  taskUpdateOperation,
  taskAssignOperation,
  taskTodayMarkOperation,
  taskDeleteOperation,
  taskRestoreOperation,
  taskMoveOperation,
  taskHistoryOperation,
  thanksSendOperation,
  thanksRevokeOperation,
  commentListOperation,
  commentCreateOperation,
  commentUpdateOperation,
  commentDeleteOperation,
  workspaceCreateOperation,
  workspaceListOperation,
  workspaceLeaderCandidatesOperation,
  workspaceInfoOperation,
  memberListOperation,
  membershipRoleUpdateOperation,
  membershipLeaveOperation,
  workspaceCloseOperation,
  workspaceReopenOperation,
  workspaceDodUpdateOperation,
  inviteeResolveOperation,
  invitationCreateOperation,
  invitationRevokeOperation,
  categoryRepositoryListOperation,
  categoryCreateOperation,
  categoryUpdateOperation,
  categoryMoveOperation,
  categoryDeleteOperation,
  repositoryCreateOperation,
  repositoryUpdateOperation,
  repositoryMoveOperation,
  repositoryDeleteOperation,
  detailFieldListOperation,
  detailFieldCreateOperation,
  detailFieldUpdateOperation,
  detailFieldMoveOperation,
  detailFieldDeleteOperation,
  taskFieldSetOperation,
  columnListOperation,
  columnCreateOperation,
  columnUpdateOperation,
  columnMoveOperation,
  columnDeleteOperation,
  connectionListOperation,
  connectionCreateOperation,
  connectionScopeCandidatesOperation,
  connectionScopesSaveOperation,
  connectionSyncOperation,
  invitationListOperation,
  invitationAcceptOperation,
  invitationDeclineOperation,
  attachmentUploadOperation,
  attachmentDownloadOperation,
  attachmentListOperation,
  attachmentDeleteOperation,
];

export const implementedOperations: readonly ImplementedOperation[] = [
  ...listedOperations,
  operationListOperationFor(listedOperations.map((operation) => operation.definition)),
];
