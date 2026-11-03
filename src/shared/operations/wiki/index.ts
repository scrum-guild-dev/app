import { z } from 'zod';
import { idSchema } from '../../id.ts';
import { wikiBodyProblem, wikiTitle } from '../../wiki.ts';
import { defineOperation } from '../define.ts';

export const wikiNodeSchema = z.object({
  id: z.string(),
  parent_id: z.string().nullable(),
  position: z.string(),
  title: z.string(),
  version: z.number().int(),
});
export const wikiPageSchema = wikiNodeSchema.extend({
  body_md: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type WikiNode = z.infer<typeof wikiNodeSchema>;
export type WikiPage = z.infer<typeof wikiPageSchema>;
const content = { title: z.string(), body_md: z.string() };
function validateContent(value: { title: string; body_md: string }, ctx: z.RefinementCtx) {
  const bodyProblem = wikiBodyProblem(value.body_md);
  if (bodyProblem !== null) ctx.addIssue({ code: 'custom', path: ['body_md'], message: bodyProblem });
  if (wikiTitle(value.title, value.body_md) === null)
    ctx.addIssue({ code: 'custom', path: ['title'], message: '題は1〜100字で入力してください' });
}
export const workspaceWikiTree = defineOperation({
  name: 'workspace-wiki-tree',
  description: 'ワークスペースの Wiki の木を読む',
  mode: 'read',
  permission: 'member',
  workspace: true,
  hideForbiddenWorkspace: true,
  input: z.object({ workspace_id: idSchema }),
  output: z.object({ pages: z.array(wikiNodeSchema) }),
});
export const workspaceWikiPage = defineOperation({
  name: 'workspace-wiki-page',
  description: 'ワークスペースの Wiki のページを読む',
  mode: 'read',
  permission: 'member',
  workspace: true,
  hideForbiddenWorkspace: true,
  input: z.object({ workspace_id: idSchema, page_id: idSchema }),
  output: z.object({ page: wikiPageSchema }),
});
export const workspaceWikiCreate = defineOperation({
  name: 'workspace-wiki-create',
  description: 'ワークスペースの Wiki にページを作る',
  mode: 'write',
  permission: 'member',
  workspace: true,
  hideForbiddenWorkspace: true,
  rateLimit: { max: 30, windowSeconds: 600 },
  input: z
    .object({ workspace_id: idSchema, parent_id: idSchema.nullable().default(null), ...content })
    .superRefine(validateContent),
  output: z.object({ page: wikiPageSchema }),
});
export const workspaceWikiUpdate = defineOperation({
  name: 'workspace-wiki-update',
  description: '読んだ版が変わっていなければ Wiki のページを保存する',
  mode: 'write',
  permission: 'member',
  workspace: true,
  hideForbiddenWorkspace: true,
  rateLimit: { max: 30, windowSeconds: 600 },
  input: z
    .object({ workspace_id: idSchema, page_id: idSchema, read_version: z.number().int().min(1), ...content })
    .superRefine(validateContent),
  output: z.object({ page: wikiPageSchema }),
});
export const wikiOperations = [workspaceWikiTree, workspaceWikiPage, workspaceWikiCreate, workspaceWikiUpdate] as const;
