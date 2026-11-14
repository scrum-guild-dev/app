-- Migration number: 0027	2026-11-14T00:00:00.000Z
-- 組織の契約（プラン、支払いの周期、追加容量の口数）。組織と1対1の共通の表で、行が無い組織は未契約（#1189）。
-- 新しい表の追加だけなので、1つ前の版はこの表を読まずに動く。1つ前の版は組織の行を物理削除しない
-- （解約した組織のデータは運用者が手順の SQL で消し、この版の手順は organizations より先に契約の行を消す）。
-- plan の custom（51人以上の個別の契約）は、SQLite で CHECK を後から変えられないので先に入れておく。書くのは後の版（#1192）。
-- 追加容量の口数はこの版では 0 のまま書く（口数を変える操作は #1191）。
CREATE TABLE organization_contracts (
  organization_id TEXT NOT NULL PRIMARY KEY REFERENCES organizations (id),
  plan TEXT NOT NULL CHECK (plan IN ('personal', 'team', 'business', 'custom')),
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('monthly', 'yearly')),
  extra_10gb_units INTEGER NOT NULL DEFAULT 0 CHECK (extra_10gb_units BETWEEN 0 AND 100),
  extra_50gb_units INTEGER NOT NULL DEFAULT 0 CHECK (extra_50gb_units BETWEEN 0 AND 100),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24 AND updated_at GLOB '????-??-??T??:??:??.???Z')
);
