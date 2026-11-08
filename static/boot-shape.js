// URL を直接開いた最初の読み込みの骨組み（src/app.html の #boot-loading、static/boot-loading.css）の形を、行き先に合わせる。
// 行き先が組織の枠（/<slug> の下）なら html に data-boot="frame" を付け、左のメニューと上の帯と本文の形の骨組みを出す。
// 枠の外の画面（ログイン、組織の選択など）は付けず、紙の形の骨組みのまま出す。
// 左のメニューを畳んだと覚えている（src/lib/nav-collapse.svelte.ts と同じキーと値）ときは data-boot-nav="collapsed" も付ける。
// 枠の外の画面の名前は src/routes の [slug] 以外の入口と同じにする（scripts/boot-shape.test.ts が突き合わせる）。
// インラインにすると CSP のハッシュから漏れて止まるので、自分のオリジンのファイルにしてある。
(function () {
  var outside = ['consent', 'invite', 'login', 'operator', 'privacy', 'signup', 'terms'];
  var first = location.pathname.split('/')[1] || '';
  if (first === '' || outside.indexOf(first) !== -1) return;
  var root = document.documentElement;
  root.dataset.boot = 'frame';
  try {
    if (localStorage.getItem('sg-nav-collapsed') === 'true') root.dataset.bootNav = 'collapsed';
  } catch {
    // 覚えていないものとして、広げた列で出す
  }
})();
