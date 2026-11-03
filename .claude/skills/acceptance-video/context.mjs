// 録画と --probe が同じ画面と入力端末を使う。録画の出力寸法は画面寸法から切り離す。
export function contextOptions(plan, videoDir) {
  const { width = 1280, height = 640, touch = false } = plan.screen ?? {};
  return {
    viewport: { width, height },
    hasTouch: touch,
    isMobile: touch,
    timezoneId: 'Asia/Tokyo',
    ...(videoDir === undefined ? {} : { recordVideo: { dir: videoDir, size: { width: 1280, height: 640 } } }),
  };
}
