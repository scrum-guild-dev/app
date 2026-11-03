export type TokenNoticeNavigation = {
  type: string;
  fromSlug: string | undefined;
  fromPath: string | undefined;
  toPath: string | undefined;
};

// 初回の load は重ねて読まず、同じ組織内の経路変更は再マウントでも読み直す。
export function shouldRefreshTokenNotice(navigation: TokenNoticeNavigation, slug: string): boolean {
  return navigation.type !== 'enter' && navigation.fromSlug === slug && navigation.fromPath !== navigation.toPath;
}
