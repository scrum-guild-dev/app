// プレビューする型は、配信が inline を許す型と揃える。
export function attachmentMedia(contentType: string): 'image' | 'video' | null {
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(contentType)) return 'image';
  if (['video/mp4', 'video/webm'].includes(contentType)) return 'video';
  return null;
}

export function attachmentSize(bytes: number): string {
  const unit = bytes >= 1024 ** 2 ? 'MB' : bytes >= 1024 ? 'KB' : 'B';
  const divisor = unit === 'MB' ? 1024 ** 2 : unit === 'KB' ? 1024 : 1;
  return `${new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 }).format(bytes / divisor)}\u00a0${unit}`;
}
