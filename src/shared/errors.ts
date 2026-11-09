// API のエラーの形（docs/development.md の「API のエラーとログ」）。画面は code で分岐し、文言は言葉の辞書から出す。

export const errorCodes = [
  'invalid_input',
  // セッションが無いか切れた。401。画面はこれを見てログインの画面へ戻す
  'unauthenticated',
  // この組織が受け付ける認証の時刻より古い。401。ログインし直す案内を出す
  'organization_reauth_required',
  // ログインしていて、権限が無い。Origin が公開する URL と違うときも
  'forbidden',
  // パスワードでのログインの、違うパスワード、無いメールアドレス、そろえ方に合わない入力。401。どれも同じ本文にする
  'invalid_credentials',
  'not_found',
  // 今の版の規約に同意していない。403。同意の操作とログアウトなど、定義に skipsConsent を付けた操作以外をすべて断る。画面は同意の画面へ移す
  'terms_required',
  'conflict',
  'attachment_quota_exceeded',
  // Wiki の検索対象が5,000ページか32MiBを超える。409。本文の走査を始めずに断る
  'wiki_search_limit',
  // クリアか中止した（終わった）エピックの討伐隊・報酬・依頼主を変える操作（epic-party-join、epic-party-leave、epic-party-assign、
  // epic-reward-update、epic-requester-update）と、中止したエピックのクリアと取り消し（epic-complete、epic-reopen）、クリア済みで配下のストーリーが
  // あるエピックを配下を残して削除する操作（epic-delete の children: 'keep'）の 409。書き込みの競合に 3 回続けて負けたときは conflict のまま。
  // 画面は「終わっているので変えられません」を出す（削除のダイアログは、まとめて削除するか先にクリアを取り消すよう案内する）
  'epic_finished',
  // ワークスペースの作成・再開（workspace-create、workspace-reopen）が、自分用の利用中の個数の上限で断られた。409。
  // details は { used, limit }（used は利用中の数）。画面は作成のダイアログか再開の一覧の上に、理由と枠を空ける方法を出す
  'workspace_limit_reached',
  // 本人のお気に入りが20件に達した。409、details は { used, limit }。
  'favorite_limit',
  // 閉じたワークスペースへの書き込み。読み取り専用なので書けない。409
  'workspace_closed',
  // 招待の作成（invitation-create）の 409。招待する人がもうそのワークスペースに所属している、同じワークスペースに承諾待ちの招待がある、
  // 組織の人数が上限に達している、画面が確かめた後にユーザー名の持ち主が変わった（解決し直した ID が違う）。
  // already_member は、招待の承諾（invitation-accept）で、もうそのワークスペースに所属しているときにも返す
  'already_member',
  'already_invited',
  'member_limit_reached',
  'invitee_changed',
  // 組織が停止している。403。停止していなければ入れた人にだけ返す（入れない人は組織が無いときと同じ not_found）。
  // 画面の組織の枠は「この組織は停止しています」を出す
  'organization_suspended',
  // 解約で停止した組織の、データを消す予定日（purge_on）を過ぎた。409。運用者の再開（organization-resume）と、
  // 一時的な停止への切り替え（organization-suspension-update の kind: temporary）と、管理者の指名し直し
  // （organization-admin-reassign）を断る。消している途中で戻さない、組織の中に行を足さないため。
  // 境目は消す SQL のガードと同じで、予定日の当日まではできる。画面は「消す予定日を過ぎたので、どれもできない」を出す
  'purge_due',
  // API トークンの発行（token-create）で、ログインから API_TOKEN_REAUTH_MINUTES 分を超えている。403。401 ではない（画面がログインの画面へ移さない）
  'reauth_required',
  // 操作の回数の上限（定義の rateLimit）を超えた。429
  'rate_limited',
  'internal',
  // 依存先（D1、GitHub）に届かない。503。人がしばらくしてからやり直せる
  'unavailable',
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export type ErrorBody = {
  error: {
    code: ErrorCode;
    // 開発者向け。画面にそのまま出さない
    message: string;
    details?: unknown;
  };
};

export function isErrorBody(value: unknown): value is ErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const { error } = value;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (errorCodes as readonly unknown[]).includes(error.code)
  );
}
