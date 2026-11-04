import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachmentMarkdown,
  AttachmentUploadError,
  moveAttachmentAnchor,
  moveMarkdownInsertion,
  uploadAttachment,
} from './attachment-upload.ts';

const uploaded = {
  id: '019cd824-65aa-7000-8000-000000000001',
  file_name: 'name[1].png',
  content_type: 'image/png',
  size_bytes: 20,
  created_at: '2026-11-04T00:00:00.000Z',
};

describe('attachment Markdown', () => {
  it('uses the server type and escapes a filename that could close the alt text', () => {
    expect(attachmentMarkdown(uploaded, 'aoba')).toBe(
      '![name\\[1\\].png](/api/aoba/attachments/019cd824-65aa-7000-8000-000000000001)',
    );
    expect(attachmentMarkdown({ ...uploaded, content_type: 'application/octet-stream' }, 'aoba')).toBeNull();
    expect(attachmentMarkdown({ ...uploaded, content_type: 'image/svg+xml' }, 'aoba')).toBeNull();
  });
  it('keeps insertion anchors through typing and deleting surrounding text', () => {
    expect(moveAttachmentAnchor('abcdef', '12abcdef', 3)).toBe(5);
    expect(moveAttachmentAnchor('abcdef', 'abef', 3)).toBe(2);
    expect(moveAttachmentAnchor('abcdef', 'abcdeXYZf', 3)).toBe(3);
    expect(moveAttachmentAnchor('abcdef', 'abcXYZdef', 3)).toBe(6);
  });
});

describe('pending image removal tracking', () => {
  const token = '![image](/api/aoba/attachments/id)';
  const before = `left${token}right`;
  const insertion = { start: 4, text: token };

  it('tracks untouched tokens through edits before and after them', () => {
    expect(moveMarkdownInsertion(before, `prefix${before}`, insertion)).toEqual({ start: 10, text: token });
    expect(moveMarkdownInsertion(before, `${before}suffix`, insertion)).toEqual(insertion);
    expect(moveMarkdownInsertion(before, token + 'right', insertion)).toEqual({ start: 0, text: token });
    expect(moveMarkdownInsertion(before, `leftX${token}right`, insertion)).toEqual({ start: 5, text: token });
    expect(moveMarkdownInsertion(before, `left${token}Xright`, insertion)).toEqual(insertion);
  });

  it('preserves user edits and never targets another copy of an edited token', () => {
    expect(moveMarkdownInsertion(before, before.replace('image', 'edited'), insertion)).toBeUndefined();
    expect(moveMarkdownInsertion(before, `leftXright${token}`, insertion)).toBeUndefined();
    expect(moveMarkdownInsertion(before, 'leftright', insertion)).toBeUndefined();
  });
});

function request() {
  const headers: Record<string, string> = {};
  const xhr = {
    open: (method: string, path: string) => {
      xhr.method = method;
      xhr.path = path;
    },
    method: '',
    path: '',
    headers,
    sent: undefined as unknown,
    setRequestHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    upload: {
      onprogress: null as ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null,
    },
    status: 200,
    responseText: JSON.stringify(uploaded),
    timeout: 0,
    ontimeout: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onabort: null as (() => void) | null,
    onload: null as (() => void) | null,
    send: (file: unknown) => {
      xhr.sent = file;
    },
    abort: () => xhr.onabort?.(),
  };
  return xhr;
}

describe('binary upload', () => {
  it('streams the File with encoded operation input, reports progress and validates response', async () => {
    const xhr = request();
    const progress: number[] = [];
    const file = new File(['png'], 'name[1].png');
    const result = uploadAttachment(file, {
      slug: 'aoba',
      workspaceId: 'workspace',
      signal: new AbortController().signal,
      progress: (n) => progress.push(n),
      createRequest: () => xhr as unknown as XMLHttpRequest,
    });
    expect(xhr.path).toBe('/api/aoba/attachment-upload');
    expect(xhr.method).toBe('POST');
    expect(xhr.sent).toBe(file);
    expect(JSON.parse(decodeURIComponent(xhr.headers['X-Operation-Input']))).toEqual({
      workspace_id: 'workspace',
      file_name: file.name,
    });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 10 });
    expect(progress).toEqual([40]);
    xhr.onload?.();
    expect(await result).toEqual(uploaded);
  });
  it('ends a stalled upload after ten minutes so the editor can resume', async () => {
    const xhr = request();
    const result = uploadAttachment(new File(['x'], 'a'), {
      slug: 'aoba',
      workspaceId: 'w',
      signal: new AbortController().signal,
      progress: () => {},
      createRequest: () => xhr as unknown as XMLHttpRequest,
    });
    expect(xhr.timeout).toBe(600_000);
    xhr.ontimeout?.();
    await expect(result).rejects.toMatchObject({ code: 'network' });
  });
  it('retains quota errors for the actionable UI and rejects malformed successes', async () => {
    const xhr = request();
    xhr.status = 409;
    xhr.responseText = JSON.stringify({ error: { code: 'attachment_quota_exceeded', message: 'limit' } });
    const result = uploadAttachment(new File(['x'], 'a'), {
      slug: 'aoba',
      workspaceId: 'w',
      signal: new AbortController().signal,
      progress: () => {},
      createRequest: () => xhr as unknown as XMLHttpRequest,
    });
    xhr.onload?.();
    await expect(result).rejects.toMatchObject({ code: 'attachment_quota_exceeded' });
    const bad = request();
    bad.responseText = '{}';
    const malformed = uploadAttachment(new File(['x'], 'a'), {
      slug: 'aoba',
      workspaceId: 'w',
      signal: new AbortController().signal,
      progress: () => {},
      createRequest: () => bad as unknown as XMLHttpRequest,
    });
    bad.onload?.();
    await expect(malformed).rejects.toBeInstanceOf(AttachmentUploadError);
  });
  it('aborts an active upload and never starts a previously cancelled upload', async () => {
    const xhr = request();
    const controller = new AbortController();
    const result = uploadAttachment(new File(['x'], 'a'), {
      slug: 'aoba',
      workspaceId: 'w',
      signal: controller.signal,
      progress: () => {},
      createRequest: () => xhr as unknown as XMLHttpRequest,
    });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    const skipped = request();
    await expect(
      uploadAttachment(new File(['x'], 'a'), {
        slug: 'aoba',
        workspaceId: 'w',
        signal: controller.signal,
        progress: () => {},
        createRequest: () => skipped as unknown as XMLHttpRequest,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(skipped.sent).toBeUndefined();
  });
});

afterEach(() => vi.unstubAllGlobals());

it('XHRの添付でも、組織の古い認証を断られたらログインへ移す', async () => {
  const replace = vi.fn();
  vi.stubGlobal('window', { location: { pathname: '/aoba/me', search: '', replace } });
  const xhr = request();
  xhr.status = 401;
  xhr.responseText = JSON.stringify({ error: { code: 'organization_reauth_required', message: '再認証' } });
  const result = uploadAttachment(new File(['x'], 'a'), {
    slug: 'aoba',
    workspaceId: 'w',
    signal: new AbortController().signal,
    progress: () => {},
    createRequest: () => xhr as unknown as XMLHttpRequest,
  });
  xhr.onload?.();
  await expect(result).rejects.toMatchObject({ code: 'organization_reauth_required' });
  expect(replace).toHaveBeenCalledWith('/login?return_to=%2Faoba%2Fme&error=organization_reauth_required');
});
