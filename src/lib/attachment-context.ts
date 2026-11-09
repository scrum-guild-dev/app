// タスク内で削除した URL。遅延読み込みやブラウザの画像キャッシュに頼らず本文へ反映する。
export const ATTACHMENT_DELETIONS = Symbol('attachment-deletions');
export type AttachmentDeletions = { urls: string[] };
