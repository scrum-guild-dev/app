import { z } from 'zod';
import { backlogQuerySchema } from '../../backlog-filter.ts';
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
export const wikiQuerySchema = backlogQuerySchema.refine((query) => query.length > 0, '検索の語を入れてください');
export const wikiSearchResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  matched_in: z.enum(['title', 'body']),
});
export type WikiSearchResult = z.infer<typeof wikiSearchResultSchema>;
const searchOutput = z.object({ pages: z.array(wikiSearchResultSchema).max(50) });
export const orgWikiSearch = defineOperation({
  name: 'org-wiki-search',
  rateLimit: { max: 30, windowSeconds: 60 },
  description: '組織の Wiki の題と本文を探す',
  mode: 'read',
  permission: 'organization',
  input: z.object({ query: wikiQuerySchema }),
  output: searchOutput,
});
export const workspaceWikiSearch = defineOperation({
  name: 'workspace-wiki-search',
  rateLimit: { max: 30, windowSeconds: 60 },
  description: 'ワークスペースの Wiki の題と本文を探す',
  mode: 'read',
  permission: 'member',
  workspace: true,
  hideForbiddenWorkspace: true,
  input: z.object({ workspace_id: idSchema, query: wikiQuerySchema }),
  output: searchOutput,
});
export const orgWikiTree = defineOperation({
  name: 'org-wiki-tree',
  description: '組織の Wiki の木を読む',
  mode: 'read',
  permission: 'organization',
  input: z.object({}),
  output: z.object({ pages: z.array(wikiNodeSchema) }),
});
export const orgWikiPage = defineOperation({
  name: 'org-wiki-page',
  description: '組織の Wiki のページを読む',
  mode: 'read',
  permission: 'organization',
  input: z.object({ page_id: idSchema }),
  output: z.object({ page: wikiPageSchema }),
});
export const orgWikiCreate = defineOperation({
  name: 'org-wiki-create',
  description: '組織の Wiki にページを作る',
  mode: 'write',
  permission: 'organization',
  rateLimit: { max: 30, windowSeconds: 600 },
  input: z.object({ parent_id: idSchema.nullable().default(null), ...content }).superRefine(validateContent),
  output: z.object({ page: wikiPageSchema }),
});
export const orgWikiUpdate = defineOperation({
  name: 'org-wiki-update',
  description: '読んだ版が変わっていなければ組織の Wiki のページを保存する',
  mode: 'write',
  permission: 'organization',
  rateLimit: { max: 30, windowSeconds: 600 },
  input: z
    .object({ page_id: idSchema, read_version: z.number().int().min(1), ...content })
    .superRefine(validateContent),
  output: z.object({ page: wikiPageSchema }),
});
export const wikiOperations = [
  workspaceWikiTree,
  workspaceWikiPage,
  workspaceWikiCreate,
  workspaceWikiUpdate,
  orgWikiSearch,
  workspaceWikiSearch,
  orgWikiTree,
  orgWikiPage,
  orgWikiCreate,
  orgWikiUpdate,
] as const;
