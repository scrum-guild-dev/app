import { env } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';
import { commonDb, orgDb } from '../src/server/db/index.ts';
import { envWithD1Hooks } from '../src/server/db/testing.ts';
import { generatedStream, MAX_BYTES, recordingBucket, upload } from './attachment-helpers.ts';
import { AT, createAttachment } from './factories.ts';
import { errorCodeOf } from './operations/harness.ts';
import { createTarget } from './operations/world.ts';

describe('容量拒否時の変更待ちと拒否順', () => {
  test('容量拒否後の変更印の保存が失敗しても元の409とR2の片付けを維持する', async () => {
    const target = await createTarget();
    const common = commonDb(env);
    await common.batch([
      common.statement((q) =>
        q
          .updateTable('organizations')
          .set({ attachment_quota_bytes: 6 * MAX_BYTES })
          .where('id', '=', target.organization.id),
      ),
    ]);
    // 小上限の先読みを避け、原子的な拒否後に変更印の保存が失敗する経路を保つ。
    for (let index = 0; index < 6; index++) {
      await createAttachment(target.organization, target.workspace.id, target.member.userId!, {
        size_bytes: MAX_BYTES - (index === 5 ? 5 : 0),
      });
    }
    const recording = recordingBucket();
    let failed = false;
    const observed = envWithD1Hooks(recording.env, {
      beforeBatch: (sqls) => {
        if (
          sqls.some(
            (sql) => sql.startsWith('update "organizations"') && sql.includes('attachment_quota_check_pending_at'),
          )
        ) {
          failed = true;
          throw new Error('秘密を含む例外の本文');
        }
      },
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await upload(target, { env: observed });
      expect(response.status).toBe(409);
      expect(await errorCodeOf(response)).toBe('attachment_quota_exceeded');
      expect(failed).toBe(true);
      const puts = recording.calls.filter((call) => call.method === 'put');
      expect(puts).toHaveLength(1);
      expect(recording.calls.filter((call) => call.method === 'delete').map((call) => call.key)).toEqual(
        puts.map((call) => call.key),
      );
      expect(await recording.bucket.get(String(puts[0]!.key))).toBeNull();
      const lines = errorLog.mock.calls.map((call) => String(call[0]));
      expect(lines.join('')).not.toContain('秘密を含む例外の本文');
      expect(lines.map((line) => JSON.parse(line) as { error?: string })).toContainEqual(
        expect.objectContaining({ error: 'Error' }),
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  test('入った後に閉じられたワークスペースでは、先読みの容量拒否よりworkspace_closedを優先する', async () => {
    const target = await createTarget();
    const common = commonDb(env);
    await common.batch([
      common.statement((q) =>
        q.updateTable('organizations').set({ attachment_quota_bytes: 8 }).where('id', '=', target.organization.id),
      ),
    ]);
    const db = orgDb(env, target.organization.verified);
    const recording = recordingBucket();
    let closed = false;
    const observed = envWithD1Hooks(recording.env, {
      afterQuery: async (sql) => {
        if (!closed && sql.includes('attachment_quota_warned_at') && sql.includes('from "organizations"')) {
          closed = true;
          await db.batch([
            db.statement((q) =>
              q
                .updateTable('workspaces')
                .set({ closed_at: AT })
                .where('id', '=', target.workspace.id)
                .where('organization_id', '=', target.organization.id),
            ),
          ]);
        }
      },
    });
    const body = generatedStream(16);
    const response = await upload(target, { env: observed, file: body.stream, contentLength: '16' });
    expect(closed).toBe(true);
    expect(response.status).toBe(409);
    expect(await errorCodeOf(response)).toBe('workspace_closed');
    expect(body.pulls()).toBe(0);
    expect(recording.calls.filter((call) => call.method === 'put')).toEqual([]);
  });
});
