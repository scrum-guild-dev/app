// 初回応答の速い0件では本文を押し下げず、長い待ちだけを知らせる。
export class TokenNoticeLoading {
  visible = $state(false);

  begin(): () => void {
    this.visible = false;
    const timer = setTimeout(() => {
      this.visible = true;
    }, 300);
    return () => {
      clearTimeout(timer);
      this.visible = false;
    };
  }
}
