import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { orgDb } from '../src/server/db/index.ts';
import { AT, uuidv7 } from './factories.ts';
import { createTarget } from './operations/world.ts';

describe('Wiki の表の制約', () => {
  test('ページは組織かワークスペースの片方だけを持つ', async () => {
    const target = await createTarget();
    const db = orgDb(env, target.organization.verified);
    const row = {
      id: uuidv7(),
      organization_id: null,
      workspace_id: target.workspace.id,
      parent_id: null,
      position: 'a0',
      title: '手順',
      body_md: '本文',
      version: 1,
      created_by: target.admin.userId!,
      updated_by: target.admin.userId!,
      created_at: AT,
      updated_at: AT,
      deleted_at: null,
      deleted_by: null,
    };
    await expect(db.run(db.statement((q) => q.insertInto('wiki_pages').values(row)))).resolves.toBeDefined();
    await expect(
      db.run(
        db.statement((q) =>
          q.insertInto('wiki_pages').values({ ...row, id: uuidv7(), organization_id: target.organization.id }),
        ),
      ),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db.run(db.statement((q) => q.insertInto('wiki_pages').values({ ...row, id: uuidv7(), workspace_id: null }))),
    ).rejects.toThrow(/CHECK/);
  });

  test('自己参照・版0・空の題・片方だけの削除記録は書けない', async () => {
    const target = await createTarget();
    const db = orgDb(env, target.organization.verified);
    const id = uuidv7();
    const row = {
      id,
      organization_id: null,
      workspace_id: target.workspace.id,
      parent_id: null,
      position: 'a0',
      title: '手順',
      body_md: '',
      version: 1,
      created_by: target.admin.userId!,
      updated_by: target.admin.userId!,
      created_at: AT,
      updated_at: AT,
      deleted_at: null,
      deleted_by: null,
    };
    for (const invalid of [
      { parent_id: id },
      { version: 0 },
      { title: '' },
      { deleted_at: AT },
      { deleted_by: target.admin.userId! },
    ]) {
      await expect(
        db.run(db.statement((q) => q.insertInto('wiki_pages').values({ ...row, ...invalid }))),
      ).rejects.toThrow(/CHECK/);
    }
  });

  test('版はページと番号の組で一意になり、存在しないページには書けない', async () => {
    const target = await createTarget();
    const db = orgDb(env, target.organization.verified);
    const pageId = uuidv7();
    await db.run(
      db.statement((q) =>
        q.insertInto('wiki_pages').values({
          id: pageId,
          organization_id: null,
          workspace_id: target.workspace.id,
          parent_id: null,
          position: 'a0',
          title: '手順',
          body_md: '',
          version: 1,
          created_by: target.admin.userId!,
          updated_by: target.admin.userId!,
          created_at: AT,
          updated_at: AT,
          deleted_at: null,
          deleted_by: null,
        }),
      ),
    );
    const row = {
      page_id: pageId,
      version: 1,
      title: '手順',
      body_md: '',
      saved_by: target.admin.userId!,
      saved_at: AT,
    };
    await db.run(db.statement((q) => q.insertInto('wiki_page_revisions').values(row)));
    await expect(db.run(db.statement((q) => q.insertInto('wiki_page_revisions').values(row)))).rejects.toThrow(
      /UNIQUE/,
    );
    await expect(
      db.run(db.statement((q) => q.insertInto('wiki_page_revisions').values({ ...row, page_id: uuidv7() }))),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});
