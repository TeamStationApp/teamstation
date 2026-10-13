import type { Kysely } from 'kysely'

import type { PlayerRsvpCounts } from '../../common/eventInfo'
import { onePerson } from '../admin/people'
import type { Database } from '../db/database'

/** Read the team's current players once, then replies for its entire schedule. */
export async function teamPlayerRsvps(
  db: Kysely<Database>,
  teamId: string,
  events: Array<{ id: string; eventKind?: 'game' | 'event' }>
): Promise<Map<string, PlayerRsvpCounts>> {
  const members = await db
    .selectFrom('memberships')
    .select('user_id')
    .where('team_id', '=', teamId)
    .where('is_player', '=', true)
    .execute()
  const identities = await Promise.all(
    members.map(async row => await onePerson(db, row.user_id))
  )
  const canonical = [...new Set(identities.map(row => row.userId))]
  const active =
    canonical.length === 0
      ? []
      : await db
          .selectFrom('users')
          .select('id')
          .where('id', 'in', canonical)
          .where('disabled_at', 'is', null)
          .where('merged_into', 'is', null)
          .execute()
  const players = new Set(active.map(row => row.id))
  const aliases = new Map<number, number>()
  for (const row of identities)
    if (players.has(row.userId))
      for (const alias of row.userIds) aliases.set(alias, row.userId)
  const counts = new Map(
    events.map(event => [event.id, { yes: 0, unknown: players.size, no: 0 }])
  )
  if (aliases.size === 0) return counts
  for (const kind of ['game', 'event'] as const) {
    const ids = events
      .filter(event => (event.eventKind ?? 'game') === kind)
      .map(event => event.id)
    if (ids.length === 0) continue
    const rows = await db
      .selectFrom(kind === 'game' ? 'game_rsvps' : 'team_event_rsvps')
      .select(['event_id', 'user_id', 'response'])
      .where('event_id', 'in', ids)
      .where('user_id', 'in', [...aliases.keys()])
      .orderBy('updated_at', 'desc')
      .orderBy('user_id')
      .execute()
    const seen = new Set<string>()
    for (const row of rows) {
      const key = `${row.event_id}/${aliases.get(row.user_id)!}`
      if (seen.has(key)) continue
      seen.add(key)
      if (row.response !== 'yes' && row.response !== 'no') continue
      const count = counts.get(row.event_id)!
      count[row.response]++
      count.unknown--
    }
  }
  return counts
}
