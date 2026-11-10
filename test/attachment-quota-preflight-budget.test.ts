import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { commonDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { attachmentQuotaWarningJob } from '../src/server/scheduled/attachment-quota-warning.ts';
import { createAttachment } from './factories.ts';
import { generatedStream, recordingBucket, upload } from './attachment-helpers.ts';
import { errorCodeOf } from './operations/harness.ts';
import { createTarget } from './operations/world.ts';

describe('添付の本文前拒否の集計予算', () => {
  test('小上限の添付拒否は要求ごとに1回だけ集計し、cronを跨いでも本文とR2を使わない', async () => {
    const target = await createTarget();
    const common = commonDb(env);
    await common.batch([
      common.statement((q) =>
        q.updateTable('organizations').set({ attachment_quota_bytes: 1000 }).where('id', '=', target.organization.id),
      ),
    ]);
    await createAttachment(target.organization, target.workspace.id, target.member.userId!, { size_bytes: 700 });
    for (const afterCron of [false, true]) {
      if (afterCron) {
        await env.ATTACHMENTS.delete('system/attachment-quota-warning-cursor');
        await attachmentQuotaWarningJob(env, new Date());
      }
      const recording = recordingBucket();
      let aggregates = 0;
      const count = (query: string) => {
        if (query.includes('wiki_page_revisions')) aggregates++;
      };
      const observed = envWithD1Hooks(recording.env, {
        afterQuery: async (query) => {
          count(query);
        },
        beforeBatch: (queries) => {
          queries.forEach(count);
        },
      });
      const body = generatedStream(400);
      const response = await upload(target, { env: observed, file: body.stream, contentLength: '400' });
      expect(response.status).toBe(409);
      expect(await errorCodeOf(response)).toBe('attachment_quota_exceeded');
      expect(aggregates, `cron後=${String(afterCron)}でも同じ要求で容量を読み直さない`).toBe(1);
      expect(body.pulls()).toBe(0);
      expect(recording.calls.filter((call) => call.method === 'put')).toEqual([]);
    }
  });
});
