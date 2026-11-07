// 接続（取り込み元の登録）の操作: 一覧、登録、範囲の候補、範囲の保存（docs/requirements.md の「取り込み」）。
// 取り込み元への通信と認証情報の暗号化は、組織の道具（organization-tools.ts）だけを通す。処理は env も fetch も受け取らない。
// 認証情報（平文、暗号文、鍵の版）は応答にもログにも出さない。出すのは末尾4文字だけ。
// 接続の表（connections）は組織の ID を持たないので、確かめたワークスペースの ID（workspace.workspaceId）で絞る
import { sql } from 'kysely';
import { now } from '../../shared/clock.ts';
import {
  CONNECTIONS_PER_MEMBER_MAX,
  connectionCreate,
  connectionList,
  connectionScopeCandidates,
  connectionScopesSave,
  type Connection,
  type ConnectionCreateProblem,
} from '../../shared/operations/connection/index.ts';
import {
  previousStatementChanged,
  type OrganizationDb,
  type QueryCreator,
  type OrganizationTables,
} from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { ImportSourceError, isImportSourceKind, type ScopeCandidate } from '../import/index.ts';
import { uuidv7 } from '../uuid.ts';
import { implement } from './implement.ts';
import type { OrganizationTools } from './organization-tools.ts';
import { actorUserIdOf, changeLogColumns, openWorkspace, throwIfClosed } from './write-guards.ts';

type Tables = OrganizationTables;
type From = Pick<QueryCreator<Tables>, 'selectFrom'>;

// 削除していない接続の行（ワークスペースで絞る）
function liveConnections(from: From, workspaceId: string) {
  return from
    .selectFrom('connections as c')
    .where('c.workspace_id', '=', workspaceId)
    .where('c.deleted_at', 'is', null);
}

// 接続の一覧の形に直して返す。connectionId を渡すとその1件。暗号文と同期の状態は選ばない
async function readConnections(db: OrganizationDb, workspaceId: string, connectionId?: string): Promise<Connection[]> {
  const [connections, scopes] = await db.batch([
    db.statement((q) => {
      const query = liveConnections(q, workspaceId)
        .leftJoin('users as u', (join) =>
          join.onRef('u.id', '=', 'c.owner_user_id').on('u.organization_id', '=', db.organizationId),
        )
        .select([
          'c.id',
          'c.workspace_id',
          'c.provider',
          'c.name',
          'c.status',
          'c.stopped_reason',
          'c.scope_mode',
          'c.credential_last4',
          'c.owner_user_id',
          'u.name as owner_name',
          'c.last_success_at',
          'c.last_error_message',
          'c.last_error_at',
          'c.consecutive_failures',
          'c.created_at',
        ])
        .orderBy('c.created_at')
        .orderBy('c.id');
      return connectionId === undefined ? query : query.where('c.id', '=', connectionId);
    }),
    db.statement((q) => {
      const query = q
        .selectFrom('connection_scopes as s')
        .innerJoin('connections as c', 'c.id', 's.connection_id')
        .where('c.workspace_id', '=', workspaceId)
        .where('c.deleted_at', 'is', null)
        .select(['s.connection_id', 's.source_id', 's.source_name'])
        .orderBy('s.source_name')
        .orderBy('s.source_id');
      return connectionId === undefined ? query : query.where('c.id', '=', connectionId);
    }),
  ] as const);
  const scopesOf = new Map<string, { id: string; name: string }[]>();
  for (const row of scopes.rows) {
    const list = scopesOf.get(row.connection_id) ?? [];
    list.push({ id: row.source_id, name: row.source_name });
    scopesOf.set(row.connection_id, list);
  }
  return connections.rows.map((row) => ({
    id: row.id,
    workspace_id: row.workspace_id,
    provider: row.provider,
    name: row.name,
    status: row.status as Connection['status'],
    stopped_reason: row.stopped_reason,
    scope_mode: row.scope_mode as Connection['scope_mode'],
    scopes: scopesOf.get(row.id) ?? [],
    credential_last4: row.credential_last4,
    owner_user_id: row.owner_user_id,
    owner_name: row.owner_name,
    last_success_at: row.last_success_at,
    last_error_message: row.last_error_message,
    last_error_at: row.last_error_at,
    consecutive_failures: Number(row.consecutive_failures),
    created_at: row.created_at,
  }));
}

function rejected(problem: ConnectionCreateProblem, message: string): ApiError {
  return new ApiError(400, 'invalid_input', [{ path: 'credential', code: problem, message }]);
}

// 取り込み元の失敗を応答の失敗に直す。メッセージは固定の文だけで、取り込み元の応答や認証情報を含まない
function importFailure(err: unknown, onRejected: () => ApiError): never {
  if (err instanceof ImportSourceError) {
    if (err.failure === 'invalid_format') throw rejected('credential_shape', '認証情報の形が合わない');
    if (err.failure === 'unauthorized' || err.failure === 'forbidden') throw onRejected();
    throw new ApiError(503, 'unavailable');
  }
  throw err;
}

export const connectionListOperation = implement(connectionList, async ({ db, workspace }) => ({
  connections: await readConnections(db, workspace.workspaceId),
}));

export const connectionCreateOperation = implement(connectionCreate, async ({ db, actor, tools, workspace, input }) => {
  const ownerUserId = actorUserIdOf(actor);
  const workspaceId = workspace.workspaceId;
  const organizationId = db.organizationId;
  if (!isImportSourceKind(input.provider)) {
    throw new ApiError(400, 'invalid_input', [
      {
        path: 'provider',
        code: 'provider_unknown' satisfies ConnectionCreateProblem,
        message: '取り込み元の種類が無い',
      },
    ]);
  }
  const source = tools.importSource(input.provider);
  // 前後の空白は呼ぶ側で取る（取り込み元の型は形の合わない値として断る）
  const credential = input.credential.trim();
  // 形が違う認証情報は、取り込み元に問い合わせずに断る
  if (!source.isCredentialShape(credential)) throw rejected('credential_shape', '認証情報の形が合わない');
  const settings = source.parseSettings(undefined);
  if (settings === null) throw new Error('取り込み元の既定の設定が検証を通らない');
  try {
    await source.verifyCredential(credential);
  } catch (err) {
    importFailure(err, () => rejected('credential_rejected', '取り込み元が認証情報を受け付けなかった'));
  }

  const at = now();
  const stamp = at.toISOString();
  const connectionId = uuidv7(at);
  const sealed = await tools.sealCredential(credential, connectionId);
  const last4 = source.credentialLast4(credential);

  const results = await db.batch([
    // 閉じたワークスペースへは入れない（登録の関数が見る閉じたかどうかは読み取りの時点の値）
    db.statement((q) =>
      q
        .insertInto('connections')
        .columns([
          'id',
          'workspace_id',
          'owner_user_id',
          'provider',
          'name',
          'status',
          'scope_mode',
          'settings_json',
          'credential_ciphertext',
          'credential_key_version',
          'credential_last4',
          'created_at',
          'updated_at',
        ])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(connectionId).as('id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(ownerUserId).as('owner_user_id'),
              eb.val(input.provider).as('provider'),
              eb.val(input.name).as('name'),
              eb.val('active').as('status'),
              eb.val('include').as('scope_mode'),
              eb.val(JSON.stringify(settings)).as('settings_json'),
              eb.val(sealed.ciphertext).as('credential_ciphertext'),
              eb.val(sealed.keyVersion).as('credential_key_version'),
              eb.val(last4).as('credential_last4'),
              eb.val(stamp).as('created_at'),
              eb.val(stamp).as('updated_at'),
            ])
            .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId)))
            // 1人が1つのワークスペースに持てる接続の数に上限を置く（共通の D1 を埋める登録の繰り返しを止める）
            .where(
              (eb) =>
                eb
                  .selectFrom('connections as limit_c')
                  .select((inner) => inner.fn.countAll<number>().as('n'))
                  .where('limit_c.workspace_id', '=', workspaceId)
                  .where('limit_c.owner_user_id', '=', ownerUserId)
                  .where('limit_c.deleted_at', 'is', null),
              '<',
              CONNECTIONS_PER_MEMBER_MAX,
            )
            // 同じ人が同じ名前で同じ種類の接続を続けて登録する再送を止める（二重の取り込みの元になる）
            .where((eb) =>
              eb.not(
                eb.exists(
                  liveConnections(q, workspaceId)
                    .select('c.id')
                    .where('c.owner_user_id', '=', ownerUserId)
                    .where('c.provider', '=', input.provider)
                    .where('c.name', '=', input.name),
                ),
              ),
            ),
        ),
    ),
    // 履歴には表示名と種類だけを残す。認証情報は入れない
    db.statement((q) =>
      q
        .insertInto('change_logs')
        .columns(changeLogColumns)
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(uuidv7(at)).as('id'),
              eb.val(organizationId).as('organization_id'),
              eb.val(workspaceId).as('workspace_id'),
              eb.val(ownerUserId).as('actor_user_id'),
              eb.val('connection').as('entity_type'),
              eb.val(connectionId).as('entity_id'),
              eb.val('create').as('action'),
              eb.val(JSON.stringify({ name: [null, input.name], provider: [null, input.provider] })).as('changes_json'),
              eb.val(stamp).as('created_at'),
            ])
            .where(previousStatementChanged),
        ),
    ),
  ] as const);
  if ((results[0]?.changes ?? 0) === 0) {
    await throwIfClosed(db, workspaceId);
    const mine = await db.first(
      db.statement((q) =>
        liveConnections(q, workspaceId)
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('c.owner_user_id', '=', ownerUserId),
      ),
    );
    throw new ApiError(409, 'conflict', {
      reason: Number(mine?.n ?? 0) >= CONNECTIONS_PER_MEMBER_MAX ? 'connection_limit' : 'duplicate_name',
    });
  }
  const [connection] = await readConnections(db, workspaceId, connectionId);
  if (connection === undefined) throw new ApiError(409, 'conflict');
  return { connection };
});

// 登録した本人の、削除していない接続の行。無い（別のワークスペース、別の組織、削除済み）は 404、本人でなければ 403
async function ownConnection(db: OrganizationDb, actorUserId: string, workspaceId: string, connectionId: string) {
  const row = await db.first(
    db.statement((q) =>
      liveConnections(q, workspaceId)
        .select(['c.id', 'c.owner_user_id', 'c.provider', 'c.credential_ciphertext', 'c.credential_key_version'])
        .where('c.id', '=', connectionId),
    ),
  );
  if (row === undefined) throw new ApiError(404, 'not_found');
  if (row.owner_user_id !== actorUserId) throw new ApiError(403, 'forbidden');
  return row;
}

// 保存した認証情報で取り込み元に範囲の候補を問い合わせる。復号は呼んだ処理の中だけで、平文を外に出さない
async function fetchCandidates(
  tools: OrganizationTools,
  row: Awaited<ReturnType<typeof ownConnection>>,
): Promise<ScopeCandidate[]> {
  if (!isImportSourceKind(row.provider)) throw new ApiError(409, 'conflict', { reason: 'provider_unknown' });
  if (row.credential_ciphertext === null || row.credential_key_version === null) {
    throw new ApiError(409, 'conflict', { reason: 'credential_missing' });
  }
  const source = tools.importSource(row.provider);
  const credential = await tools.openCredential(
    { ciphertext: row.credential_ciphertext, keyVersion: Number(row.credential_key_version) },
    row.id,
  );
  try {
    return await source.listScopeCandidates(credential);
  } catch (err) {
    return importFailure(err, () => new ApiError(409, 'conflict', { reason: 'credential_rejected' }));
  }
}

export const connectionScopeCandidatesOperation = implement(
  connectionScopeCandidates,
  async ({ db, actor, tools, workspace, input }) => {
    const row = await ownConnection(db, actorUserIdOf(actor), workspace.workspaceId, input.connection_id);
    return { candidates: await fetchCandidates(tools, row) };
  },
);

export const connectionScopesSaveOperation = implement(
  connectionScopesSave,
  async ({ db, actor, tools, workspace, input }) => {
    const actorUserId = actorUserIdOf(actor);
    const workspaceId = workspace.workspaceId;
    const organizationId = db.organizationId;
    const row = await ownConnection(db, actorUserId, workspaceId, input.connection_id);
    const source = isImportSourceKind(row.provider) ? tools.importSource(row.provider) : undefined;
    if (source === undefined) throw new ApiError(409, 'conflict', { reason: 'provider_unknown' });

    // 名前は取り込み元の候補から引く。候補に無い ID は断る（画面から送られた名前を保存しない）
    const candidates = new Map((await fetchCandidates(tools, row)).map((candidate) => [candidate.id, candidate]));
    const chosen: ScopeCandidate[] = [];
    const seen = new Set<string>();
    for (const id of input.source_ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const candidate = candidates.get(id);
      if (candidate === undefined) {
        throw new ApiError(400, 'invalid_input', [
          { path: 'source_ids', code: 'scope_unknown', message: '範囲の候補に無い ID' },
        ]);
      }
      chosen.push(candidate);
    }

    const at = now();
    const stamp = at.toISOString();
    const logId = uuidv7(at);
    // 置き換える文は、履歴の行（この要求の ID）があるときだけ動く。履歴は、接続の更新が行を変えたときだけ入る
    const logged = (q: Pick<QueryCreator<Tables>, 'selectFrom'>) =>
      q.selectFrom('change_logs').select('change_logs.id').where('change_logs.id', '=', logId);
    const statements = [
      db.statement((q) =>
        q
          .updateTable('connections')
          .set({ scope_mode: 'include', updated_at: stamp })
          .where('id', '=', row.id)
          .where('workspace_id', '=', workspaceId)
          .where('owner_user_id', '=', actorUserId)
          .where('deleted_at', 'is', null)
          .where((eb) => eb.exists(openWorkspace(q, organizationId, workspaceId))),
      ),
      db.statement((q) =>
        q
          .insertInto('change_logs')
          .columns(changeLogColumns)
          .expression(
            q
              .selectNoFrom((eb) => [
                eb.val(logId).as('id'),
                eb.val(organizationId).as('organization_id'),
                eb.val(workspaceId).as('workspace_id'),
                eb.val(actorUserId).as('actor_user_id'),
                eb.val('connection').as('entity_type'),
                eb.val(row.id).as('entity_id'),
                eb.val('update').as('action'),
                // 前の件数は履歴の文の中で数える（読んでから書くまでの並行する保存で食い違わない）
                sql<string>`json_object('scopes_count', json_array((select count(*) from connection_scopes where connection_id = ${row.id}), ${chosen.length}))`.as(
                  'changes_json',
                ),
                eb.val(stamp).as('created_at'),
              ])
              .where(previousStatementChanged),
          ),
      ),
      db.statement((q) =>
        q
          .deleteFrom('connection_scopes')
          .where('connection_id', '=', row.id)
          .where((eb) => eb.exists(logged(q))),
      ),
    ];
    // 1行ずつ文にする（上限 200 件）。履歴の行があるときだけ入る
    for (const candidate of chosen) {
      statements.push(
        db.statement((q) =>
          q
            .insertInto('connection_scopes')
            .columns(['connection_id', 'scope_kind', 'source_id', 'source_name'])
            .expression(
              q
                .selectNoFrom((eb) => [
                  eb.val(row.id).as('connection_id'),
                  eb.val(source.scopeKind).as('scope_kind'),
                  eb.val(candidate.id).as('source_id'),
                  eb.val(candidate.name).as('source_name'),
                ])
                .where((eb) => eb.exists(logged(q))),
            ),
        ),
      );
    }
    const results = await db.batch(statements as never);
    if (((results as readonly { changes?: number }[])[0]?.changes ?? 0) === 0) {
      await throwIfClosed(db, workspaceId);
      // 読んだ後に接続が削除されたときは、存在しないときと同じ 404
      await ownConnection(db, actorUserId, workspaceId, row.id);
      throw new ApiError(409, 'conflict');
    }
    const [connection] = await readConnections(db, workspaceId, row.id);
    if (connection === undefined) throw new ApiError(404, 'not_found');
    return { connection };
  },
);
