import { z } from 'zod';
import { backlogQuerySchema } from '../../backlog-filter.ts';
import { idSchema } from '../../id.ts';
import { wikiBodyProblem, wikiTitle } from '../../wiki.ts';
import { WIKI_UPLOAD_MAX_FILES, WIKI_UPLOAD_MAX_REQUEST_BYTES, wikiUploadProblem } from '../../wiki-transfer.ts';
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
  input: z.object({ workspace_id: idSchema, page_id: idSchema, revision: z.number().int().min(1).optional() }),
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
  input: z.object({ page_id: idSchema, revision: z.number().int().min(1).optional() }),
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
export const wikiRevisionSchema = z.object({
  title: z.string(),
  version: z.number().int(),
  saved_by: z.string(),
  saved_by_name: z.string(),
  saved_at: z.string(),
});
export const workspaceWikiRevisions = defineOperation({
  name: 'workspace-wiki-revisions',
  description: 'ワークスペースの Wiki の版を新しい順に読む',
  mode: 'read',
  permission: 'member',
  workspace: true,
  hideForbiddenWorkspace: true,
  input: z.object({ workspace_id: idSchema, page_id: idSchema }),
  output: z.object({ revisions: z.array(wikiRevisionSchema) }),
});
export const orgWikiRevisions = defineOperation({
  name: 'org-wiki-revisions',
  description: '組織の Wiki の版を新しい順に読む',
  mode: 'read',
  permission: 'organization',
  input: z.object({ page_id: idSchema }),
  output: z.object({ revisions: z.array(wikiRevisionSchema) }),
});

// after_page_id: null は先頭、省略は末尾。同じ Wiki の移動先の兄弟だけを指せる。
const moveInput = {
  page_id: idSchema,
  parent_id: idSchema.nullable(),
  after_page_id: idSchema.nullable().optional(),
};
export const orgWikiMove = defineOperation({
  name: 'org-wiki-move',
  description: '組織の Wiki のページを並べ替えるか、同じ Wiki の親へ移す',
  mode: 'write',
  permission: 'organization',
  input: z.object(moveInput),
  output: z.object({ page_id: z.string(), parent_id: z.string().nullable() }),
});
export const workspaceWikiMove = defineOperation({
  name: 'workspace-wiki-move',
  description: 'ワークスペースの Wiki のページを並べ替えるか、同じ Wiki の親へ移す',
  mode: 'write',
  permission: 'member',
  workspace: true,
  hideForbiddenWorkspace: true,
  input: z.object({ workspace_id: idSchema, ...moveInput }),
  output: z.object({ page_id: z.string(), parent_id: z.string().nullable() }),
});
const uploadFiles = z
  .array(
    z.object({ file_name: z.string(), body_md: z.string() }).superRefine((file, ctx) => {
      const problem = wikiUploadProblem(file);
      if (problem)
        ctx.addIssue({
          code: 'custom',
          path: [problem === 'extension' || problem === 'file_name' ? 'file_name' : 'body_md'],
          message: problem,
        });
    }),
  )
  .min(1)
  .max(WIKI_UPLOAD_MAX_FILES);
const uploadLimit = {
  max: 30,
  windowSeconds: 600,
  weight: (input: unknown) => (input as { files: unknown[] }).files.length,
};
export const orgWikiUpload = defineOperation({
  name: 'org-wiki-upload',
  description: '.mdを組織のWikiへまとめて取り込む',
  mode: 'write',
  permission: 'organization',
  weightedRateLimit: uploadLimit,
  requestRateLimit: { max: 60, windowSeconds: 60 },
  maxBodyBytes: WIKI_UPLOAD_MAX_REQUEST_BYTES,
  input: z.object({ parent_id: idSchema.nullable().default(null), files: uploadFiles }),
  output: z.object({ pages: z.array(wikiNodeSchema) }),
});
export const workspaceWikiUpload = defineOperation({
  name: 'workspace-wiki-upload',
  description: '.mdをワークスペースのWikiへまとめて取り込む',
  mode: 'write',
  permission: 'member',
  workspace: true,
  hideForbiddenWorkspace: true,
  weightedRateLimit: uploadLimit,
  requestRateLimit: { max: 60, windowSeconds: 60 },
  maxBodyBytes: WIKI_UPLOAD_MAX_REQUEST_BYTES,
  input: z.object({ workspace_id: idSchema, parent_id: idSchema.nullable().default(null), files: uploadFiles }),
  output: z.object({ pages: z.array(wikiNodeSchema) }),
});
export const wikiOperations = [
  orgWikiUpload,
  workspaceWikiUpload,
  orgWikiMove,
  workspaceWikiMove,
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
  workspaceWikiRevisions,
  orgWikiRevisions,
] as const;
