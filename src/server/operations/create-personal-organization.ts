import { createPersonalOrganization } from '../../shared/operations/organization/index.ts';
import { implement } from './implement.ts';

export const createPersonalOrganizationOperation = implement(createPersonalOrganization, async () => {
  throw new Error('未実装');
});
