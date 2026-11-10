import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { attachmentQuotaWarningJob } from '../src/server/scheduled/attachment-quota-warning.ts';
import { createAttachment } from './factories.ts';
import { generatedStream, recordingBucket, upload } from './attachment-helpers.ts';
import { errorCodeOf } from './operations/harness.ts';
import { createTarget } from './operations/world.ts';

async function fixture(used: number) {
  const target = await createTarget();
  const common = commonDb(env);
  await common.batch([
    common.statement((q) =>
      q.updateTable('organizations').set({ attachment_quota_bytes: 1000 }).where('id', '=', target.organization.id),
    ),
  ]);
  if (used > 0)
    await createAttachment(target.organization, target.workspace.id, target.member.userId!, { size_bytes: used });
  return target;
}

describe('容量拒否後の再確認と残量の境界', () => {
  test('使用量が80%未満でも、容量拒否後のcronを跨いだ同じ添付は本文とR2の前に断る', async () => {
    const target = await fixture(700);
    const first = recordingBucket();
    const response = await upload(target, { env: first.env, file: generatedStream(400).stream, contentLength: '400' });
    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe('attachment_quota_exceeded');
    const db = orgDb(env, target.organization.verified);
    const attachments = await db.rows(
      db.statement((q) =>
        q.selectFrom('attachments').select('size_bytes').where('workspace_id', '=', target.workspace.id),
      ),
    );
    expect(attachments).toEqual([{ size_bytes: 700 }]);
    await env.ATTACHMENTS.delete('system/attachment-quota-warning-cursor');
    await attachmentQuotaWarningJob(env, new Date());
    const second = recordingBucket();
    const body = generatedStream(400);
    const repeated = await upload(target, { env: second.env, file: body.stream, contentLength: '400' });
    expect(repeated.status).toBe(409);
    expect(await errorCodeOf(repeated)).toBe('attachment_quota_exceeded');
    expect(body.pulls()).toBe(0);
    expect(second.calls.filter((call) => call.method === 'put')).toEqual([]);
  });

  for (const [used, incoming] of [
    [700, 300],
    [0, 1000],
  ] as const) {
    test(`使用量${used}と送信${incoming}が上限ちょうどなら拒否しない`, async () => {
      const target = await fixture(used);
      const body = generatedStream(incoming);
      const recording = recordingBucket();
      const response = await upload(target, { env: recording.env, file: body.stream, contentLength: String(incoming) });
      expect(response.status).toBe(200);
      expect(body.pulls()).toBeGreaterThan(0);
      expect(recording.calls.filter((call) => call.method === 'put')).toHaveLength(1);
    });
  }
});
