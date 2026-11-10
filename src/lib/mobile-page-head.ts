import type { Snippet } from 'svelte';

// AppShell の検索・アカウントを PageHead で使う。枠の外の PageHead はこの context を持たない。
export const MOBILE_PAGE_HEAD = Symbol('mobile-page-head');
export type MobilePageHead = {
  readonly narrow: boolean;
  readonly tools: Snippet;
  register: (id: symbol) => () => void;
  owns: (id: symbol) => boolean;
};
