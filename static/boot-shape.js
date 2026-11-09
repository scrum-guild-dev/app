// URL を直接開いた最初の読み込みの骨組み（src/app.html の #boot-loading、static/boot-loading.css）の形を、行き先に合わせる。
// 行き先が組織の枠（/<slug> の下）なら html に data-boot="<形>" を付け、左のメニューと上の帯と、行き先の本文の組みに近い骨組みを出す。
// 形と URL の対応は src/lib/loading-shape.ts（画面を移るときの LoadingSheet）と同じにする（scripts/boot-shape.test.ts が突き合わせる）。
// 枠の外の画面（ログイン、組織の選択、届いた招待など）と、どの画面にも当たらない URL は付けず、紙の形の骨組みのまま出す。
// ログインの有無と組織に入れるかは見ないので、/<1語> は組織の枠の形で出し、読み込んだ後に見つからない画面やログインの画面に替わることがある。
// 左のメニューを畳んだと覚えている（src/lib/nav-collapse.svelte.ts と同じキーと値）ときは data-boot-nav="collapsed" も付ける。
// #boot-loading の後に置いて同期で読む（本文の骨組みを #boot-loading の中に組み立てるため）。骨組みが見える 300ms より前に終わる。
// インラインにすると CSP のハッシュから漏れて止まるので、自分のオリジンのファイルにしてある。中身は固定の文字列だけで、URL の値は入れない
(function () {
  var outside = ['auth', 'consent', 'invite', 'login', 'operator', 'privacy', 'signup', 'terms'];
  var workspacePages = {
    connections: 'list',
    inbox: 'list',
    members: 'list',
    plan: 'plan',
    settings: 'settings',
    sprint: 'board',
  };

  function shapeOf(parts) {
    if (parts.length === 0 || outside.indexOf(parts[0]) !== -1) return null;
    if (parts.length === 1) return 'today';
    var page = parts[1];
    if (parts.length === 2 && page === 'admin') return 'settings';
    if (parts.length === 2 && page === 'me') return 'aside';
    if (parts.length === 2 && page === 'favorites') return 'list';
    if (page === 'wiki' && parts.length <= 3) return 'wiki';
    if (page !== 'w' || parts.length < 3) return null;
    if (parts.length === 3) return 'tree';
    var sub = parts[3];
    if (parts.length === 4 && Object.prototype.hasOwnProperty.call(workspacePages, sub)) return workspacePages[sub];
    if (sub === 'wiki' && parts.length <= 5) return 'wiki';
    if (parts.length === 5 && sub === 'epics') return 'aside';
    if (parts.length === 5 && sub === 'tasks') return 'task';
    return null;
  }

  function repeat(html, count) {
    var out = '';
    for (var i = 0; i < count; i++) out += html;
    return out;
  }

  var card = '<i class="is-card"></i>';
  var bodies = {
    today: '<i class="is-heading"></i>' + card + '<i class="is-heading"></i>' + card,
    aside:
      '<b class="boot-cols is-aside"><b><i class="is-heading"></i>' +
      card +
      '<i class="is-heading"></i>' +
      card +
      '</b><i class="is-panel"></i></b>',
    tree:
      '<b class="boot-row"><i class="is-input"></i>' +
      repeat('<i class="is-select"></i>', 4) +
      '</b>' +
      repeat('<i class="is-item"></i>', 8),
    board:
      '<b class="boot-board">' +
      repeat('<b class="boot-col"><i class="is-short"></i>' + card + card + '</b>', 4) +
      '</b>',
    plan: '<i class="is-chart"></i><b class="boot-cols is-lanes">' + repeat('<i class="is-lane"></i>', 3) + '</b>',
    list: '<i class="is-heading"></i>' + repeat('<i class="is-item"></i>', 6),
    settings: repeat(
      '<b class="boot-cols is-setting"><b><i class="is-heading"></i><i></i><i class="is-short"></i></b>' +
        card +
        '</b>',
      3,
    ),
    wiki:
      '<b class="boot-cols is-wiki"><b><i class="is-short"></i><i class="is-input"></i><i class="is-button"></i></b>' +
      '<i class="is-panel"></i></b>',
    task:
      '<b class="boot-row is-end">' +
      repeat('<i class="is-button"></i>', 4) +
      '</b><i class="is-title"></i>' +
      repeat('<b class="boot-row"><i class="is-label"></i><i class="is-value"></i></b>', 6) +
      card +
      card,
  };

  // 区切りごとに文字に直して比べる（SvelteKit も直してから画面に当てる。/%6Cogin はログインの画面）。直せない URL は紙の形のまま
  var parts;
  try {
    parts = location.pathname
      .split('/')
      .filter(function (part) {
        return part !== '';
      })
      .map(decodeURIComponent);
  } catch {
    return;
  }
  var shape = shapeOf(parts);
  if (shape === null) return;
  var root = document.documentElement;
  root.dataset.boot = shape;
  try {
    if (localStorage.getItem('sg-nav-collapsed') === 'true') root.dataset.bootNav = 'collapsed';
  } catch {
    // 覚えていないものとして、広げた列で出す
  }
  var content = document.querySelector('#boot-loading .boot-content');
  if (!content) return;
  var actions = shape === 'plan' || shape === 'wiki' ? '<i class="is-button"></i>' : '';
  var head =
    shape === 'task'
      ? ''
      : '<b class="boot-head"><i class="is-eyebrow"></i><b class="boot-head-row"><i class="is-title"></i>' +
        actions +
        '</b><i class="is-stats"></i></b>';
  content.innerHTML = head + '<b class="boot-body">' + bodies[shape] + '</b>';
})();
