import type { Page } from '@playwright/test';
import { expect } from './fixtures.ts';
import { operationPath } from '../src/shared/operations/define.ts';
import { workspaceCreate } from '../src/shared/operations/workspace/workspace-create.ts';

// Wiki の長い操作を確かめるケースでは、管理画面の操作を繰り返さず、実 API で専用の場所を用意する。
// ワークスペース作成の画面は workspace.test.ts が確かめる。各ケースのデータは別のワークスペースに分ける。
export async function createWikiWorkspace(page: Page, baseURL: string | undefined, name: string): Promise<string> {
  if (!baseURL) throw new Error('baseURL が無い');
  const response = await page.request.post(operationPath(workspaceCreate, 'aoba'), {
    headers: { Origin: new URL(baseURL).origin },
    data: workspaceCreate.input.parse({
      name,
      timezone: 'Asia/Tokyo',
      leader_user_id: '019a0000-0000-7000-8000-000000000301',
    }),
  });
  expect(response.status()).toBe(200);
  const { workspace_id } = workspaceCreate.output.parse(await response.json());
  return `/aoba/w/${workspace_id}/wiki`;
}
