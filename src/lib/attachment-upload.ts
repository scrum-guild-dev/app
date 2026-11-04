import { isErrorBody } from '../shared/errors.ts';
import { attachmentUpload } from '../shared/operations/attachment/index.ts';
import { operationPath, type OutputOf } from '../shared/operations/define.ts';

export type UploadedAttachment = OutputOf<typeof attachmentUpload>;
export class AttachmentUploadError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

// XHR exposes upload progress and abort without buffering the file in JavaScript.
export function uploadAttachment(
  file: File,
  options: {
    slug: string;
    workspaceId: string;
    signal: AbortSignal;
    progress: (percent: number) => void;
    createRequest?: () => XMLHttpRequest;
  },
): Promise<UploadedAttachment> {
  return new Promise((resolve, reject) => {
    const xhr = options.createRequest?.() ?? new XMLHttpRequest();
    const finish = () => options.signal.removeEventListener('abort', abort);
    const fail = (code: string) => {
      finish();
      reject(new AttachmentUploadError(code));
    };
    const abort = () => {
      xhr.abort();
      fail('cancelled');
    };
    if (options.signal.aborted) {
      fail('cancelled');
      return;
    }
    xhr.open('POST', operationPath(attachmentUpload, options.slug));
    // Release the editor if the connection stalls instead of blocking saving indefinitely.
    xhr.timeout = 10 * 60 * 1000;
    xhr.ontimeout = () => fail('network');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader(
      'X-Operation-Input',
      encodeURIComponent(JSON.stringify({ workspace_id: options.workspaceId, file_name: file.name })),
    );
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.progress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    };
    xhr.onerror = () => fail('network');
    xhr.onabort = () => fail('cancelled');
    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        fail('invalid_response');
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        fail(isErrorBody(body) ? body.error.code : String(xhr.status));
        return;
      }
      const parsed = attachmentUpload.output.safeParse(body);
      if (!parsed.success) {
        fail('invalid_response');
        return;
      }
      finish();
      resolve(parsed.data);
    };
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      xhr.send(file);
    } catch {
      fail('network');
    }
  });
}

export function attachmentMarkdown(file: UploadedAttachment, slug: string): string | null {
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.content_type)) return null;
  const alt = file.file_name.replace(/[\\[\]`*_<>]/g, '\\$&').replace(/[\r\n]/g, ' ');
  return `![${alt}](/api/${encodeURIComponent(slug)}/attachments/${encodeURIComponent(file.id)})`;
}

// Keep an upload's insertion point attached to the surrounding text while the user types.
export function moveAttachmentAnchor(before: string, after: string, anchor: number): number {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let suffix = 0;
  while (
    suffix < before.length - start &&
    suffix < after.length - start &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  if (anchor < start) return anchor;
  if (anchor >= before.length - suffix) return Math.max(start, anchor + after.length - before.length);
  return after.length - suffix;
}
