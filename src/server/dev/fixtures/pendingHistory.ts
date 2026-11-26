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

/** Independent synthetic inboxes for empty, paged and large-history tab reads. */
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
  for (const role of [
    'small',
    'empty',
    'paged',
    'sent',
    'history',
    'information',
    'inaccessible'
  ]) {
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
    if (role === 'information') {
      for (let at = 0; at < 10000; at += 100) {
        await db
          .insertInto('notification_events')
          .values(
            Array.from({ length: 100 }, (_, i) => ({
              id: randomUUID(),
              source_type: 'schedulePublished',
              source_id: randomUUID(),
              revision: 1,
              actor_id: null,
              metadata: JSON.stringify({
                title: 'Synthetic schedule update',
                description: 'Historical notification fixture'
              }),
              recorded_recipients: [reader.userId],
              created_at: new Date(now.getTime() - 60000 + at + i)
            }))
          )
          .execute()
      }
      ids.informationCount = '10000'
      continue
    }
    const resolved = ['sent', 'history', 'inaccessible'].includes(role)
      ? 10000
      : 1000
    const active =
      role === 'paged' || role === 'sent' ? 30 : role === 'inaccessible' ? 1 : 0
    const rows = Array.from({ length: resolved + active }, (_, i) => ({
      id: randomUUID(),
      kind: 'membership' as const,
      sender_id: role === 'sent' ? reader.userId : sender.userId,
      sender_scope_type: null,
      sender_scope_id: null,
      terms: JSON.stringify({
        kind: 'membership',
        teamId: team.id,
        userId: sender.userId
      }),
      status:
        i >= resolved || role === 'inaccessible'
          ? ('pending' as const)
          : (['accepted', 'declined', 'cancelled', 'expired'] as const)[i % 4],
      sent_at: new Date(
        now.getTime() -
          60_000 +
          (role === 'inaccessible' && i >= resolved ? 10000 : 0)
      ),
      expires_at: new Date(now.getTime() + 86_400_000),
      resolved_at: i >= resolved || role === 'inaccessible' ? null : now,
      resolved_by:
        i >= resolved || role === 'inaccessible' ? null : reader.userId,
      game_id: null,
      initiating_team_id: null,
      supersedes_id: null
    }))
    for (let at = 0; at < rows.length; at += 100) {
      const batch = rows.slice(at, at + 100)
      await db.insertInto('group_requests').values(batch).execute()
      await db
        .insertInto('group_request_sides')
        .values(
          batch.map((row, i) => ({
            request_id: row.id,
            scope_type: 'team' as const,
            scope_id:
              role === 'inaccessible' && at + i < resolved
                ? randomUUID()
                : team.id,
            approved_by: null,
            approved_at: null
          }))
        )
        .execute()
      if (role === 'inaccessible')
        await db
          .insertInto('notification_events')
          .values(
            batch.map(row => ({
              id: randomUUID(),
              source_type: 'groupRequest',
              source_id: row.id,
              revision: 1,
              metadata: '{}',
              recorded_recipients: [reader.userId],
              created_at: row.sent_at
            }))
          )
          .execute()
    }
    ids[`${role}Active`] = rows
      .slice(resolved)
      .map(row => row.id)
      .join(',')
    ids[`${role}HistoryCount`] = String(role === 'inaccessible' ? 0 : resolved)
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
