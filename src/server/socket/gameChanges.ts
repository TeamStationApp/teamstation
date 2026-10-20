import { asEither, asObject, asString } from 'cleaners'
import { type Kysely, sql } from 'kysely'

import { asLiteral } from '../../common/asLiteral'
import { asUserId } from '../../common/userId'
import type { Database } from '../db/database'

/**
 * The channel every write that changes a game announces itself on.
 *
 * Each worker holds one `LISTEN` on it (`fanout.ts`) and passes a change on to
 * the sockets it has subscribed to that game, so a write in one worker reaches
 * a viewer connected to another. A notify is delivered when its transaction
 * commits, so a write that rolls back announces nothing.
 */
export const GAME_CHANGES_CHANNEL = 'game_changes'

/** What a game's own writes announce. */
export type GameNotifyKind = 'plays' | 'game' | 'lineups'

/** The two payloads: one game's change, or a player's song on one team. */
export type GameChangePayload =
  | { game: string; kind: GameNotifyKind }
  | { team: string; kind: 'walkUpSong'; userId: string }

export const asGameChangePayload = asEither(
  asObject({
    game: asString,
    kind: asLiteral('plays', 'game', 'lineups')
  }),
  asObject({
    team: asString,
    kind: asLiteral('walkUpSong'),
    userId: asUserId
  })
)

/** Announces a change, inside the caller's transaction. */
export async function notifyGameChange(
  db: Kysely<Database>,
  payload: GameChangePayload
): Promise<void> {
  await sql`select pg_notify(${GAME_CHANGES_CHANNEL}, ${JSON.stringify(payload)})`.execute(
    db
  )
}
