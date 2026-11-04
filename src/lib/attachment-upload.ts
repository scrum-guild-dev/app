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

export type MarkdownInsertion = { start: number; text: string };
export type TextEditRange = { start: number; end: number };

function matchesEditRange(before: string, after: string, edit: TextEditRange): boolean {
  const insertedLength = after.length - before.length + edit.end - edit.start;
  return (
    Number.isInteger(edit.start) &&
    Number.isInteger(edit.end) &&
    edit.start >= 0 &&
    edit.end >= edit.start &&
    edit.end <= before.length &&
    insertedLength >= 0 &&
    before.slice(0, edit.start) === after.slice(0, edit.start) &&
    before.slice(edit.end) === after.slice(edit.start + insertedLength)
  );
}

// beforeinput carries the actual selection, avoiding ambiguous string diffs for repeated text.
// Collapsed deletes describe the caret; the actual removed length includes whole graphemes/words.
export function resolveInputEdit(
  before: string,
  after: string,
  selection: TextEditRange & { inputType: string },
): TextEditRange | undefined {
  const { inputType } = selection;
  if (!inputType.startsWith('insert') && !inputType.startsWith('delete')) return undefined;
  let { start, end } = selection;
  if (start === end && inputType.startsWith('delete')) {
    const removed = before.length - after.length;
    if (removed <= 0) return undefined;
    if (inputType.endsWith('Backward')) start -= removed;
    else if (inputType.endsWith('Forward')) end += removed;
    else return undefined;
  }
  const edit = { start, end };
  return matchesEditRange(before, after, edit) ? edit : undefined;
}

// A pending image can be removed automatically only while its original token is untouched.
// Edits around the token move it; an edit inside it gives ownership of that text to the writer.
export function moveMarkdownInsertion(
  before: string,
  after: string,
  insertion: MarkdownInsertion,
  edit?: TextEditRange,
): MarkdownInsertion | undefined {
  if (edit && !matchesEditRange(before, after, edit)) return undefined;
  let changeStart = 0;
  while (changeStart < before.length && changeStart < after.length && before[changeStart] === after[changeStart])
    changeStart++;
  let suffix = 0;
  while (
    suffix < before.length - changeStart &&
    suffix < after.length - changeStart &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  const beforeEnd = edit?.end ?? before.length - suffix;
  changeStart = edit?.start ?? changeStart;
  const tokenEnd = insertion.start + insertion.text.length;
  let start = insertion.start;
  if (beforeEnd <= insertion.start) start += after.length - before.length;
  else if (changeStart < tokenEnd) return undefined;
  if (after.slice(start, start + insertion.text.length) !== insertion.text) return undefined;
  return { start, text: insertion.text };
}

// File-copy clipboards can expose names as text/plain; only that exact metadata is omitted.
export function clipboardTextToInsert(raw: string, files: readonly { name: string }[]): string {
  const text = raw.replace(/\r\n?/g, '\n');
  const names = files.map((file) => file.name).join('\n');
  if (files.length > 0 && (text === names || text === `${names}\n`)) return '';
  return text;
}
