import { describe, expect, test } from 'vitest';
import { attachmentMedia, attachmentSize } from './attachment-display.ts';

describe('添付の表示', () => {
  test.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])('%s を画像として開く', (type) => {
    expect(attachmentMedia(type)).toBe('image');
  });
  test.each(['video/mp4', 'video/webm'])('%s を動画として開く', (type) => {
    expect(attachmentMedia(type)).toBe('video');
  });
  test.each(['image/svg+xml', 'text/html', 'application/pdf', 'application/octet-stream'])(
    '%s はダウンロードする',
    (type) => {
      expect(attachmentMedia(type)).toBeNull();
    },
  );
  test('容量の境界と端数を読みやすく示す', () => {
    expect(attachmentSize(1)).toBe('1\u00a0B');
    expect(attachmentSize(1024)).toBe('1\u00a0KB');
    expect(attachmentSize(1536)).toBe('1.5\u00a0KB');
    expect(attachmentSize(1024 ** 2)).toBe('1\u00a0MB');
    expect(attachmentSize(50 * 1024 ** 2)).toBe('50\u00a0MB');
  });
});
