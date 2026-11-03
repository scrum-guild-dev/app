import { sql, type Expression, type RawBuilder } from 'kysely';

// 旧版の確認列が NULL の行は created_at を同じ瞬間の UTC ミリ秒にそろえて比べる。
// created_at の列自体に CHECK は無く、時差・秒精度の表記もありうる。
// 読めない古い値は最古の日時に倒し、未確認の発行を隠さない。
export function apiTokenSeenAt(seenAt: Expression<string | null>, createdAt: Expression<string>): RawBuilder<string> {
  // SQLite が日時として受ける now・Julian day は、この列の ISO 日時ではない。
  // UTC への変換で4桁の年の範囲を越えるものも、確認列の CHECK に渡さない。
  const normalized = sql<string | null>`strftime('%Y-%m-%dT%H:%M:%fZ', ${createdAt})`;
  const legacy = sql<string | null>`CASE
    WHEN ${createdAt} GLOB '[0-9][0-9][0-9][0-9]-??-??T*'
      AND length(${normalized}) = 24
    THEN ${normalized}
  END`;
  return sql<string>`coalesce(${seenAt}, ${legacy}, '0000-01-01T00:00:00.000Z')`;
}
