import { accountProfileSave, onboardingStatus } from '../../shared/operations/session/onboarding.ts';
import { implement } from './implement.ts';

export const accountProfileSaveOperation = implement(accountProfileSave, async () => {
  throw new Error('未実装');
});

export const onboardingStatusOperation = implement(onboardingStatus, async () => {
  throw new Error('未実装');
});
