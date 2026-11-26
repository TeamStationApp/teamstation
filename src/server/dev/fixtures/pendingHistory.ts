import { randomUUID } from 'node:crypto'

import {
  RECORDING_UPLOAD,
  UMPIRE_MISSING_SLOTS
} from '../../../common/notifications'
import { PLAYER_ADD_REJECTED } from '../../notifications/pending'
import type { PlayerRemovedMetadata } from '../../notifications/requestInformation'
import { createTeam } from '../../teams/createTeam'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

/** Three independent inboxes, each with a thousand resolved synthetic requests. */
export async function runPendingHistory(
  context: WorldContext
): Promise<FixtureManifest> {
  const { db, nonce } = context
  const world = 'pending-history'
  const sender = await createAccount(context, world, 'sender', {
    first: 'Mike',
    last: 'Trout'
  })
  const accounts: FixtureManifest['accounts'] = { sender }
  const ids: Record<string, string> = {}
  const now = new Date()
  for (const role of ['small', 'empty', 'paged']) {
    const reader = await createAccount(context, world, role, {
      first: 'Mookie',
      last: 'Betts'
    })
    accounts[role] = reader
    const teamName = `Fixture Owls ${nonce} ${role}`
    const team = await createTeam(
      db,
      { name: teamName, externalIds: [] },
      { userId: reader.userId, isAdmin: false }
    )
    ids[`${role}Team`] = team.id
    const rows = Array.from(
      { length: 1000 + (role === 'paged' ? 30 : 0) },
      (_, i) => ({
        id: randomUUID(),
        kind: 'membership' as const,
        sender_id: sender.userId,
        sender_scope_type: null,
        sender_scope_id: null,
        terms: JSON.stringify({
          kind: 'membership',
          teamId: team.id,
          userId: sender.userId
        }),
        status:
          i >= 1000
            ? ('pending' as const)
            : (['accepted', 'declined', 'cancelled', 'expired'] as const)[
                i % 4
              ],
        sent_at: new Date(now.getTime() - 60_000),
        expires_at: new Date(now.getTime() + 86_400_000),
        resolved_at: i >= 1000 ? null : now,
        resolved_by: i >= 1000 ? null : reader.userId,
        game_id: null,
        initiating_team_id: null,
        supersedes_id: null
      })
    )
    for (let at = 0; at < rows.length; at += 100) {
      const batch = rows.slice(at, at + 100)
      await db.insertInto('group_requests').values(batch).execute()
      await db
        .insertInto('group_request_sides')
        .values(
          batch.map(row => ({
            request_id: row.id,
            scope_type: 'team' as const,
            scope_id: team.id,
            approved_by: null,
            approved_at: null
          }))
        )
        .execute()
    }
    ids[`${role}Active`] = rows
      .slice(1000)
      .map(row => row.id)
      .join(',')
    if (role !== 'small') continue
    for (const [type, title] of [
      [RECORDING_UPLOAD, 'Upload your recording'],
      [PLAYER_ADD_REJECTED, 'Player add rejected'],
      [UMPIRE_MISSING_SLOTS, 'Missing umpire slots']
    ]) {
      const id = randomUUID()
      ids[type] = id
      await db
        .insertInto('notification_events')
        .values({
          id,
          source_type: type,
          source_id: id,
          revision: 1,
          actor_id: null,
          metadata: JSON.stringify(
            type === PLAYER_ADD_REJECTED
              ? ({
                  teamId: team.id,
                  teamName,
                  userId: sender.userId,
                  mode: 'roster',
                  games: 0,
                  remover: 'coach'
                } satisfies PlayerRemovedMetadata)
              : {
                  title,
                  description: 'Synthetic inbox reminder',
                  userId: sender.userId
                }
          ),
          recorded_recipients: [reader.userId],
          created_at: now
        })
        .execute()
    }
  }
  return { world, nonce, accounts, ids }
}
