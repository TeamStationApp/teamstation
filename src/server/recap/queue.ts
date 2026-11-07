import { createHash, randomUUID } from 'node:crypto'

import { type Kysely, sql } from 'kysely'

import type { GumboPlay } from '../../common/gumboPlay'
import type { Database } from '../db/database'
import { namedScoringGame } from '../scoring/openRow'
import { announceNotedScopes } from '../socket/syncRevision'
import type { RecapInput } from './model'

/** Include every model input, even play updates made outside a full scoring post. */
export async function recapSnapshot(
  db: Kysely<Database>,
  gameId: string
): Promise<{ input: RecapInput; contextDigest: string }> {
  const game = await db
    .selectFrom('games')
    .selectAll()
    .where('id', '=', gameId)
    .executeTakeFirstOrThrow()
  const rows = await db
    .selectFrom('events')
    .select('gumbo')
    .where('gameId', '=', gameId)
    .orderBy('atBatIndex')
    .execute()
  const named = await namedScoringGame(
    db,
    { plays: rows.map(r => r.gumbo as GumboPlay), currentPlay: null },
    { gameId, spoken: true }
  )
  const teams = await db
    .selectFrom('teams')
    .select(['id', 'name'])
    .where('id', 'in', [game.home_team_id, game.away_team_id])
    .execute()
  const context = {
    homeTeam: teams.find(t => t.id === game.home_team_id)!.name,
    awayTeam: teams.find(t => t.id === game.away_team_id)!.name,
    date: new Intl.DateTimeFormat('en-US', {
      timeZone: game.timezone,
      dateStyle: 'long'
    }).format(new Date(game.start_at)),
    homeScore: game.home_score,
    awayScore: game.away_score
  }
  return {
    input: { ...context, plays: named.game.plays },
    contextDigest: createHash('sha256')
      .update(
        JSON.stringify([
          named.names.digest,
          named.game.plays,
          context,
          game.start_at,
          game.timezone
        ])
      )
      .digest('hex')
  }
}

/** Called under the post's game lock. No network work belongs in this transaction. */
export async function requestRecap(
  db: Kysely<Database>,
  gameId: string,
  final: boolean,
  digest: string
): Promise<void> {
  if (!final) {
    await db.deleteFrom('game_recaps').where('game_id', '=', gameId).execute()
    return
  }
  const contextDigest = (await recapSnapshot(db, gameId)).contextDigest
  await db
    .insertInto('game_recaps')
    .values({
      game_id: gameId,
      request_id: randomUUID(),
      digest,
      context_digest: contextDigest,
      status: 'pending',
      attempts: 0,
      available_at: new Date(),
      lease_id: null,
      document: null
    })
    .onConflict(oc =>
      oc
        .column('game_id')
        .doUpdateSet({
          request_id: randomUUID(),
          digest,
          context_digest: contextDigest,
          status: 'pending',
          attempts: 0,
          available_at: new Date(),
          lease_id: null,
          document: null
        })
        .where(eb =>
          eb.or([
            eb('game_recaps.digest', '!=', digest),
            eb('game_recaps.context_digest', 'is', null),
            eb('game_recaps.context_digest', '!=', contextDigest),
            eb('game_recaps.status', '=', 'failed')
          ])
        )
    )
    .execute()
}

/** Exhausted leases count as failures too, including a process lost on attempt three. */
export async function expireRecaps(
  db: Kysely<Database>,
  now: Date
): Promise<void> {
  await db.transaction().execute(async trx => {
    const expired = await trx
      .updateTable('game_recaps')
      .set({ status: 'failed', lease_id: null })
      .where('status', '=', 'pending')
      .where('attempts', '>=', 3)
      .where('available_at', '<=', now)
      .returning('game_id')
      .execute()
    if (expired.length > 0)
      await announceNotedScopes(
        trx,
        expired.map(row => ({ gameId: row.game_id }))
      )
  })
}

export const finalGame = sql<boolean>`exists (select 1 from games where games.id = game_recaps.game_id and games.status = 'final')`
