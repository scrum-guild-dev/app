import { z } from 'zod';
import { timezoneSchema } from '../../timezone.ts';
import { defineOperation } from '../define.ts';

export const onboardingWorkspacePrepare = defineOperation({
  name: 'onboarding-workspace-prepare',
  description:
    'チームの導入用に、開いている自分のリーダー所属を再利用する。未作成なら最初のワークスペースを1つだけ作る',
  mode: 'write',
  permission: 'admin',
  input: z.object({ timezone: timezoneSchema }),
  output: z.object({ workspace_id: z.string() }),
});
