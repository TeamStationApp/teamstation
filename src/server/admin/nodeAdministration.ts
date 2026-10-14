import type { Kysely } from 'kysely'

import { badRequest, conflict, forbidden, notFound } from '../../common/errors'
import type { GroupRef } from '../../common/groupCreation'
import { makeId } from '../../common/ids'
import type {
  NodeAccount,
  NodeAccountChange
} from '../../common/nodeAdministration'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { requireDirectAdmin } from '../groups/adminGuard'
import { currentActor } from '../groups/rights'
import { imageUrl } from '../media/imageUrls'
import type { SpaceSettings } from '../media/spacesHls'

export async function requireNodeAdmin(
  db: Kysely<Database>,
  actor: Actor,
  message = 'Only a node administrator can manage accounts'
): Promise<Actor> {
  const fresh = await currentActor(db, actor)
  if (!fresh.isAdmin) throw forbidden(message)
  return fresh
}
async function activeNodeIds(db: Kysely<Database>): Promise<number[]> {
  return (
    await db
      .selectFrom('users')
      .select('id')
      .where('is_admin', '=', true)
      .where('login_enabled', '=', true)
      .where('disabled_at', 'is', null)
      .where('merged_into', 'is', null)
      .execute()
  ).map(user => user.id)
}
export async function nodeAccounts(
  db: Kysely<Database>,
  actor: Actor,
  query = '',
  nodeAdmin = false,
  space?: SpaceSettings
): Promise<NodeAccount[]> {
  await requireNodeAdmin(db, actor)
  if (query.length > 120)
    throw badRequest('Search must be at most 120 characters')
  const nodes = await activeNodeIds(db)
  let rows = db
    .selectFrom('users')
    .select([
      'id',
      'display_name',
      'is_admin',
      'disabled_at',
      'login_enabled',
      'avatar_path'
    ])
    .select(eb =>
      eb
        .selectFrom('user_emails')
        .select('email')
        .whereRef('user_emails.user_id', '=', 'users.id')
        .where('verified_at', 'is not', null)
        .orderBy('is_primary', 'desc')
        .orderBy('email')
        .limit(1)
        .as('email')
    )
    .where('merged_into', 'is', null)
    .where('login_enabled', '=', true)
  if (nodeAdmin) rows = rows.where('is_admin', '=', true)
  if (query.trim() !== '')
    rows = rows.where(eb =>
      eb.or([
        eb(
          'display_name',
          'ilike',
          '%' + query.replace(/[\\%_]/g, '\\$&') + '%'
        ),
        eb.exists(
          eb
            .selectFrom('user_emails')
            .select('id')
            .whereRef('user_emails.user_id', '=', 'users.id')
            .where(
              'email',
              'ilike',
              '%' + query.replace(/[\\%_]/g, '\\$&') + '%'
            )
        )
      ])
    )
  const people = await rows.orderBy('display_name').orderBy('id').execute()
  const result: NodeAccount[] = []
  for (const user of people) {
    result.push({
      userId: user.id,
      displayName: user.display_name,
      email: user.email ?? null,
      avatarUrl: space == null ? null : imageUrl(space, user.avatar_path),
      isNodeAdmin: user.is_admin,
      suspended: user.disabled_at != null,
      loginEnabled: user.login_enabled,
      canRemoveNodeRole: !nodes.includes(user.id) || nodes.length > 1
    })
  }
  return result
}

/** Suspension is reversible; identities and authored game history remain intact. */
export async function changeNodeAccount(
  db: Kysely<Database>,
  actor: Actor,
  userId: number,
  body: NodeAccountChange
): Promise<void> {
  await atomic(db, async trx => {
    await lockKeys(trx, ['creation:parent-graph', 'node:administration'])
    const fresh = await requireNodeAdmin(trx, actor)
    const target = await trx
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirst()
    if (target == null || target.merged_into != null) throw notFound()
    const disabledAt =
      body.suspended === undefined
        ? target.disabled_at
        : body.suspended
          ? (target.disabled_at ?? new Date())
          : null
    const isNodeAdmin = body.isNodeAdmin ?? target.is_admin
    if (
      isNodeAdmin &&
      (!target.login_enabled || disabledAt != null) &&
      body.isNodeAdmin === true
    )
      throw conflict(
        'Verify this account and reactivate it before granting a node role'
      )
    if (
      body.isNodeAdmin === true &&
      (await trx
        .selectFrom('user_emails')
        .select('id')
        .where('user_id', '=', userId)
        .where('verified_at', 'is not', null)
        .executeTakeFirst()) == null
    )
      throw conflict('Verify an email before granting a node role')
    const groups = await trx
      .selectFrom('scope_roles')
      .select(['scope_type', 'scope_id'])
      .where('user_id', '=', userId)
      .where('role', '=', 'admin')
      .execute()
    const owners = await trx
      .selectFrom('memberships')
      .select('team_id')
      .where('user_id', '=', userId)
      .where('role', 'in', ['owner', 'manager'])
      .execute()
    const refs: GroupRef[] = [
      ...groups.map(row => ({ kind: row.scope_type, id: row.scope_id })),
      ...owners.map(row => ({ kind: 'team' as const, id: row.team_id }))
    ]
    await trx
      .updateTable('users')
      .set({
        is_admin: isNodeAdmin,
        disabled_at: disabledAt,
        updated_at: new Date()
      })
      .where('id', '=', userId)
      .execute()
    if ((await activeNodeIds(trx)).length === 0)
      throw conflict(
        'Add another active node administrator before removing the last one'
      )
    if (disabledAt != null) {
      for (const ref of refs) await requireDirectAdmin(trx, ref)
      await trx
        .updateTable('auth_sessions')
        .set({ revoked_at: new Date() })
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .execute()
      await trx
        .updateTable('api_tokens')
        .set({ revoked_at: new Date() })
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .execute()
      await trx
        .updateTable('live_streams')
        .set({
          state: 'revoked',
          closes_at: new Date(),
          updated_at: new Date(),
          last_error:
            'The publishing account was suspended. Ask for a new stream URL.'
        })
        .where('user_id', '=', userId)
        .where('state', 'in', ['idle', 'publishing'])
        .execute()
    }
    await trx
      .insertInto('audit_log')
      .values({
        id: makeId('audit'),
        actor_user_id: fresh.userId,
        api_token_id: null,
        method: 'PATCH',
        path: '/users/:userId/administration',
        entity_type: 'user',
        entity_id: String(userId),
        before: {
          isNodeAdmin: target.is_admin,
          suspended: target.disabled_at != null
        },
        after: { isNodeAdmin, suspended: disabledAt != null }
      })
      .execute()
  })
}
