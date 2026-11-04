import type { ErrorBody } from '../shared/errors.ts';
import { t } from './vocabulary.svelte.ts';

// 添付の 404 と保存先の 404 を区別し、本文を残して再追加できるようにする。
export function attachmentSaveFailure(
  status: number,
  error: ErrorBody['error'] | null,
  pending: string[],
): string | null {
  const details = error?.details;
  if (typeof details !== 'object' || details === null || !('attachment_ids' in details)) return null;
  const ids = details.attachment_ids;
  if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string')) return null;
  const missing = status === 404;
  const attached = status === 409 && 'reason' in details && details.reason === 'attachment_attached';
  if (!missing && !attached) return null;
  const rejected = new Set(ids);
  // 保存が失敗した ID だけを外す。本文中の Markdown と、それ以外の添付は保持する。
  for (let i = pending.length - 1; i >= 0; i--) if (rejected.has(pending[i])) pending.splice(i, 1);
  return t(missing ? 'attachmentMissing' : 'attachmentAlreadyAttached');
}
